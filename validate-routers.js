// validate-routers.js — Checksummed routers only (ethers v6)

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

// --- main ---
async function runOnce() {
  const routers = await readJson("./routers.json");
  let changed = false;

  // Ensure all existing routers are checksummed
  for (const [name, val] of Object.entries(routers)) {
    if (!val || !val.address) {
      routers[name] = { address: ethers.ZeroAddress };
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
    } catch {
      routers[name] = { address: ethers.ZeroAddress };
      changed = true;
      console.warn(`⚠️ Invalid router ${name}, set to ZeroAddress`);
    }
  }

  if (changed) {
    await writeJson("./routers.json", routers);
    console.log("✅ Routers sanitized and checksummed.");
  } else {
    console.log("✅ All routers valid, no changes.");
  }
}

// --- run once ---
runOnce().catch((err) => console.error("[VALIDATOR CRASH]", err?.message || err));