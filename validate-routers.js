// validate-routers.js — Checksummed routers + on-chain validation + quarantined flag (ethers v6)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

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
    console.log(`[JSON WRITE] Saved: ${rel}`);
  } catch (err) {
    console.error(`[JSON WRITE ERROR] ${rel}:`, err?.message || err);
  }
}

// --- known routers to attempt to add ---
const KNOWN_VALID = {
  "dfyn-v2": "0xA102072A4C07F06EC3B4900fdc4c7b80b6c57429",
  "quickswap-v3": "0xF5b509bB0909a69B1c207E495f687a596C168E12"
};

// --- on-chain verification ---
async function verifyOnChain(provider, address, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const code = await provider.getCode(address);
      if (code && code !== "0x") return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// --- main ---
async function runOnce() {
  const routers = await readJson("./routers.json");
  let changed = false;

  const provider = new ethers.JsonRpcProvider("https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY");

  // Attempt to add DFYN v2 & QuickSwap v3 if verified on-chain
  for (const [name, addr] of Object.entries(KNOWN_VALID)) {
    try {
      const checksummed = ethers.getAddress(addr);
      const ok = await verifyOnChain(provider, checksummed);
      if (ok) {
        if (!routers[name] || routers[name].address !== checksummed) {
          routers[name] = { address: checksummed, quarantined: false };
          changed = true;
          console.log(`✅ Router ${name} verified on-chain & added`);
        }
      } else {
        console.warn(`⚠️ Router ${name} failed on-chain check, skipped`);
      }
    } catch {
      console.warn(`⚠️ Invalid router ${name}: ${addr}`);
    }
  }

  // Ensure existing routers are checksummed
  for (const [name, val] of Object.entries(routers)) {
    if (!val || !val.address) {
      routers[name] = { address: ethers.ZeroAddress, quarantined: true };
      changed = true;
      console.warn(`⚠️ Router ${name} missing address, set to ZeroAddress`);
      continue;
    }
    try {
      const checksummed = ethers.getAddress(val.address);
      if (val.address !== checksummed) {
        routers[name].address = checksummed;
        changed = true;
        console.log(`✅ Router ${name} checksummed`);
      }
      if (routers[name].quarantined === undefined) {
        routers[name].quarantined = false;
        changed = true;
      }
    } catch {
      routers[name] = { address: ethers.ZeroAddress, quarantined: true };
      changed = true;
      console.warn(`⚠️ Invalid router ${name}, set to ZeroAddress`);
    }
  }

  if (changed) {
    await writeJson("./routers.json", routers);
    console.log("✅ Routers sanitized, poolfetcher-safe & quarantined status set.");
  } else {
    console.log("✅ All routers valid & poolfetcher-safe, no changes.");
  }
}

// --- run once ---
runOnce().catch((err) => console.error("[VALIDATOR CRASH]", err?.message || err));