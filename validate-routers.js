// validate-routers.js — Checksummed routers-only (ethers v6)

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

function isAddr(a) {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

// --- main validator ---
async function runOnce() {
  const routers = await readJson("./routers.json");
  let changed = false;

  for (const [name, rawAddr] of Object.entries(routers)) {
    let addrStr = rawAddr;

    // If it's an object, try to extract .address
    if (typeof rawAddr === "object" && rawAddr !== null && rawAddr.address) {
      addrStr = rawAddr.address;
    }

    try {
      const checksummed = ethers.getAddress(addrStr);
      if (checksummed !== routers[name]) {
        routers[name] = checksummed; // overwrite with checksum
        changed = true;
        console.log(`✅ Router ${name} checksummed: ${checksummed}`);
      }
    } catch {
      routers[name] = ethers.ZeroAddress;
      changed = true;
      console.warn(`⚠️ Invalid router ${name}: ${addrStr}, set to ZeroAddress`);
    }
  }

  if (changed) {
    await writeJson("./routers.json", routers);
    console.log("✅ Routers sanitized & checksummed.");
  } else {
    console.log("✅ All routers valid and checksummed, no changes.");
  }
}

// --- run once ---
runOnce().catch((err) => console.error("[VALIDATOR CRASH]", err?.message || err));