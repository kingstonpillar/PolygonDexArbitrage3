// validate-configs.js — Routers-only with auto-correct (ethers v6, readProvider-safe)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers, Contract } from "ethers";
import { sendTelegramAlert } from "./telegramalert.js";
import { getReadProvider } from "./dataprovider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- util: JSON ---
async function readJson(rel) {
  const p = path.join(__dirname, rel);
  try {
    const raw = await fs.promises.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[JSON READ ERROR] ${rel}:`, err?.message || err);
    return {};
  }
}

async function writeJson(rel, data) {
  const p = path.join(__dirname, rel);
  try {
    await fs.promises.writeFile(p, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[JSON WRITE ERROR] ${rel}:`, err?.message || err);
  }
}

function isAddr(a) {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

// --- concurrency limiter (FIFO, no spin) ---
const MAX_CONCURRENT = 2;
let active = 0;
const waiters = [];

async function withLimit(task) {
  if (active >= MAX_CONCURRENT) {
    await new Promise((res) => waiters.push(res));
  }
  active++;
  try {
    return await task();
  } finally {
    active--;
    if (waiters.length) waiters.shift()();
  }
}

// --- retry + timeout (readProvider auto-rotates on failure) ---
const DEFAULT_TIMEOUT_MS = 2000;

function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);
}

async function safeCall(fn, retries = 3, delayMs = 1000, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const provider = await getReadProvider();
      return await withLimit(() =>
        withTimeout(fn(provider), timeoutMs, "rpc_timeout")
      );
    } catch (err) {
      lastErr = err;
      console.warn(`[RPC ERROR] attempt ${i + 1}: ${err?.message || err}`);
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  return null;
}

// --- alert throttle ---
const alertedKeys = new Set();

async function alertOnce(key, msg) {
  if (alertedKeys.has(key)) return;
  alertedKeys.add(key);
  try {
    await sendTelegramAlert(msg);
  } catch (e) {
    console.warn(`[ALERT ERROR] ${e?.message || e}`);
  }
}

// --- router validator (uses safeCall wrapper) ---
async function validateRouter(addr) {
  if (!isAddr(addr)) return { ok: false, reason: "bad_address" };

  const abiV2 = ["function factory() view returns (address)"];

  const factory = await safeCall(async (provider) => {
    const c = new Contract(addr, abiV2, provider);
    return c.factory();
  });

  if (factory && isAddr(factory)) return { ok: true, reason: "v2" };

  const code = await safeCall(async (provider) => provider.getCode(addr));
  if (code && code !== "0x") return { ok: true, reason: "no_factory_method" };

  return { ok: false, reason: "no_code_or_call_failed" };
}

// --- auto-correct using factory() ---
async function autoCorrectRouter(addr) {
  if (!isAddr(addr)) return null;
  const abi = ["function factory() view returns (address)"];

  const factory = await safeCall(async (provider) => {
    const c = new Contract(addr, abi, provider);
    return c.factory();
  });

  if (factory && isAddr(factory)) {
    const check = await validateRouter(addr);
    if (check.ok) return addr;
  }
  return null;
}

// --- main validator pass ---
async function runOnce() {
  let routers = await readJson("./routers.json");
  let changed = false;

  for (const [name, addr] of Object.entries(routers)) {
    let checksummedAddr;
    try {
      checksummedAddr = ethers.getAddress(addr); // ✅ ethers v6 correct usage
    } catch {
      console.warn(`⚠️ Invalid address for ${name}: ${addr}, setting to zero address`);
      routers[name] = ethers.ZeroAddress; // ✅ ethers v6 constant
      await alertOnce(
        `router-invalid:${name}`,
        `⚠️ Invalid address for ${name}: ${addr}`
      );
      changed = true;
      continue;
    }

    const { ok, reason } = await validateRouter(checksummedAddr);

    if (!ok) {
      console.warn(`⚠️ Router flagged for ${name}: ${checksummedAddr} (${reason})`);

      const corrected = await autoCorrectRouter(checksummedAddr);
      if (corrected) {
        routers[name] = corrected;
        console.log(`🔧 Auto-corrected router for ${name}: ${corrected}`);
        await alertOnce(
          `router-corrected:${name}`,
          `🔧 Auto-corrected router for ${name}: ${corrected}`
        );
      } else {
        routers[name] = ethers.ZeroAddress; // ✅ quarantine using ZeroAddress
        await alertOnce(
          `router:${name}`,
          `⚠️ Router for ${name} quarantined: ${checksummedAddr} (${reason})`
        );
      }
      changed = true;
    } else {
      routers[name] = checksummedAddr;
    }
  }

  if (changed) {
    await writeJson("./routers.json", routers);
    console.log("✅ Routers validated & corrected/quarantined where needed.");
  } else {
    console.log("✅ All routers valid, no changes.");
  }
}

// --- main loop ---
async function mainLoop(intervalMs = 30000) {
  while (true) {
    try {
      await runOnce();
    } catch (err) {
      console.error("[VALIDATOR CRASH DURING ITERATION]", err?.message || err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

mainLoop().catch((err) => {
  console.error("[VALIDATOR CRASH AT STARTUP]", err?.message || err);
});
