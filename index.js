// index.js — Boot sequence for PolygonDexArbitrage system
// Ensure package.json has: { "type": "module" }

import "dotenv/config";
import { protect } from "./crash-protection.js";
import { getReadProvider, verifySameChain } from "./dataprovider.js";

// === Graceful module auto-loader with restart loop ===
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

// === Boot Sequence ===
async function boot() {
  try {
    console.log("🔧 Boot sequence: initializing dataprovider first (RPC + limiter)");

    // 1️⃣ Initialize provider
    const readProvider = await getReadProvider();
    console.log("➡️ Read provider connected.");

    // 2️⃣ Verify correct chain
    try {
      await verifySameChain(readProvider);
      console.log("✅ Provider verified on Polygon chain.");
    } catch (err) {
      console.error("❌ Chain verification failed:", err?.message || err);
      console.log("Restarting process in 5s...");
      return setTimeout(() => process.exit(1), 5000);
    }

    // 3️⃣ Activate crash protection
    protect();
    console.log("🛡️ Crash-protection enabled.");

    // 4️⃣ Validate routers (sanity check)
    console.log("➡️ Validating routers…");
    await import("./validate-routers.js");
    console.log("✅ Routers validated.");

    // 5️⃣ Start CORE modules (non-blocking)
    const coreModules = [
      { name: "Backrun Watcher",          path: "./backrunwatcher.js" },
      { name: "Price Impact Estimator",   path: "./priceImpactEstimator.js" },
      { name: "Pool Executor",            path: "./poolexecutor.js" },
      { name: "Broadcast Manager",        path: "./broadcast.js" },
      { name: "Protection Utilities",     path: "./protectionutilities.js" },
      { name: "Arbitrage Opportunities",  path: "./arbopportunities.js" }, // 🆕 added core module
    ];

    coreModules.forEach((m) => startModule(m.name, m.path));

    // 6️⃣ Start HELPER modules (DEX + analytics helpers)
    const helperModules = [
      { name: "V2/V3 Resolver",        path: "./v2v3resolver.js" },
      { name: "Uniswap Oracle Helper", path: "./uniswapOracle.js" },
      { name: "Slippage Helper",       path: "./slippagehelper.js" },
      { name: "Liquidity Helper",      path: "./liquidity.js" },
      { name: "KyberElastic Helper",   path: "./kyberelastic.js" },
      { name: "Gas Helper",            path: "./gashelper.js" },
      { name: "Balancer + Curve",      path: "./balancercurve.js" },
    ];

    helperModules.forEach((m) => startModule(m.name, m.path));

    console.log("🎯 All modules are starting up...");
  } catch (err) {
    console.error("[BOOT FAILURE]", err?.message || err);
    setTimeout(() => process.exit(1), 2000);
  }
}

// 🏁 Start the system
boot();

// === Graceful shutdown ===
function shutdown(sig) {
  console.log(`\n${sig} received. Attempting graceful shutdown…`);
  setTimeout(() => process.exit(0), 500);
}
["SIGINT", "SIGTERM"].forEach((s) => process.on(s, () => shutdown(s)));

// === Global safety nets ===
process.on("unhandledRejection", (r) => console.error("⚠️ UnhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("⚠️ UncaughtException:", e));