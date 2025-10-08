// index.js — Boot sequence: dataprovider → validate-configs → other modules
// Ensure package.json has: { "type": "module" }

import "./assign_ids.js"; // pre-start assignment
import { protect } from "./crash-protection.js";
import { getReadProvider, getWriteProvider, verifySameChain } from "./dataprovider.js";

// start/restart wrapper for non-blocking modules
function startModule(name, modulePath) {
  const start = async () => {
    console.log(`🚀 Starting ${name}...`);
    try {
      await import(modulePath);
      console.log(`✅ ${name} loaded successfully.`);
    } catch (err) {
      console.error(`❌ ${name} crashed during import:`, err?.message || err);
      console.log(`⏳ Restarting ${name} in 5 seconds...`);
      setTimeout(start, 5000);
    }
  };
  start();
}

async function boot() {
  try {
    console.log("🔧 Boot sequence: initialize dataprovider first (providers + limiter)");

    // 1) initialize read + write providers
    console.log("➡️ Building read provider...");
    const readProvider = await getReadProvider();
    console.log("➡️ Building write provider...");
    const writeProvider = await getWriteProvider();

    // 2) verify network / chain sanity (catch errors to avoid crash)
    console.log("🔎 Verifying read/write providers are on the expected chain...");
    try {
      await verifySameChain(readProvider, writeProvider);
      console.log("✅ Providers verified on target chain.");
    } catch (err) {
      console.error("❌ verifySameChain failed:", err?.message || err);
      console.log("⏳ Exiting to allow process manager to restart...");
      return process.exit(1); // restart via PM2/systemd/Docker
    }

    // 3) start crash protection
    protect();
    console.log("🛡️ Crash-protection enabled.");

    // 4) validate-configs (runs its own loop on import)
    console.log("➡️ Importing validate-configs…");
    await import("./validate-configs.js");
    console.log("✅ validate-configs started.");

    // 5) start remaining non-blocking modules
    const modules = [
      { name: "Pool Fetcher",          path: "./poolfetcher.js" },
      { name: "Scanner",               path: "./scanner.js" },
      { name: "Protection Utilities",  path: "./protectionutilities.js" },
      { name: "Hybrid Simulation Bot", path: "./hybridsimulationbot.js" },
      { name: "Chainlink Price Feed",  path: "./getchainlinkpricefeed.js" },
      { name: "Token List Updater",    path: "./updatetokenlist.js" },
      { name: "Direct Pool Listener",  path: "./checkdirectpool.js" },
      { name: "Tri Pool Listener",     path: "./check_tri_pool.js" },
      // add any other modules here (DO NOT re-import dataprovider)
    ];

    modules.forEach((m) => startModule(m.name, m.path));
    console.log("🎯 All non-blocking services starting...");
  } catch (err) {
    console.error("[BOOT FAILURE]", err?.message || err);
    setTimeout(() => process.exit(1), 100); // ensures process manager restarts
  }
}

// boot the app
boot();

// graceful shutdown
function shutdown(sig) {
  console.log(`\n${sig} received. Attempting graceful shutdown…`);
  setTimeout(() => process.exit(0), 500);
}
["SIGINT", "SIGTERM"].forEach((s) => process.on(s, () => shutdown(s)));

// catch unhandled errors for logging
process.on("unhandledRejection", (r) => console.error("UnhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("UncaughtException:", e));