// index.js — start dataprovider first, then validate-configs, then the rest
// Ensure package.json has: { "type": "module" }

import "./assign_ids.js"; // keep pre-start assignment
import { protect } from "./crash-protection.js";
import * as dataprovider from "./dataprovider.js";

// start/restart wrapper used for non-blocking modules
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

    // 1) initialize read + write providers (builds providers inside dataprovider)
    console.log("➡️ Building read provider...");
    await dataprovider.getReadProvider();
    console.log("➡️ Building write provider...");
    await dataprovider.getWriteProvider();

    // 2) verify network / chain sanity (throws if mismatch)
    console.log("🔎 Verifying read/write providers are on the expected chain...");
    await dataprovider.verifySameChain();
    console.log("✅ Providers verified on target chain.");

    // 3) start crash protection (monitor/restart supervisor)
    protect();
    console.log("🛡️ Crash-protection enabled.");

    // 4) run validate-configs next (it runs its own loop on import)
    console.log("➡️ Importing validate-configs (will validate routers)…");
    await import("./validate-configs.js");
    console.log("✅ validate-configs started.");

    // 5) start remaining modules (dataprovider already initialized)
    const modules = [
      { name: "Pool Fetcher",         path: "./poolfetcher.js" },
      { name: "Scanner",              path: "./scanner.js" },
      { name: "Protection Utilities", path: "./protectionutilities.js" },
      { name: "Hybrid Simulation Bot",path: "./hybridsimulationbot.js" },
      { name: "Chainlink Price Feed", path: "./getchainlinkpricefeed.js" },
      { name: "Token List Updater",   path: "./updatetokenlist.js" },
      { name: "Direct Pool Listener", path: "./checkdirectpool.js" },
      { name: "Tri Pool Listener",    path: "./check_tri_pool.js" },
      // add any other modules here (DO NOT re-import dataprovider)
    ];

    modules.forEach((m) => startModule(m.name, m.path));
    console.log("🎯 All non-blocking services starting...");
  } catch (err) {
    console.error("[BOOT FAILURE]", err?.message || err);
    // Hard exit so your process manager (PM2/systemd/Docker) restarts cleanly
    setTimeout(() => process.exit(1), 100);
  }
}

boot();

// graceful shutdown
function shutdown(sig) {
  console.log(`\n${sig} received. Attempting graceful shutdown…`);
  setTimeout(() => process.exit(0), 500);
}
["SIGINT", "SIGTERM"].forEach((s) => process.on(s, () => shutdown(s)));

// Optional: catch unhandled errors to let crash-protection decide
process.on("unhandledRejection", (r) => {
  console.error("UnhandledRejection:", r);
});
process.on("uncaughtException", (e) => {
  console.error("UncaughtException:", e);
});
