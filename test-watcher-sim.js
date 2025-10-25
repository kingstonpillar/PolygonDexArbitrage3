// test-watcher-sim.js
import "dotenv/config";
import { watcher, getHubTokens, startBackrunWatcher } from "./backrunWatcher.js";

console.log("🧠 Testing Hub Tokens...");
const tokens = getHubTokens();
console.log("Hub Tokens (lowercase, unique):", tokens);

// Simulate a fake arb opportunity to test the EventEmitter
watcher.on("arbOpportunity", (data) => {
  console.log("\n🚨 Fake Arbitrage Opportunity Detected 🚨");
  console.log("Live DEX:", data.live.dex);
  console.log("Catch DEX:", data.catch.dex);
  console.log("Δ Price %:", data.catch.diffPct.toFixed(3));
  console.log("Liquidity:", data.live.liquidityUSD.toFixed(2), "USD");
  console.log("TxHash:", data.txHash);
  console.log("--------------------------------------");
});

// Emit a fake opportunity
watcher.emit("arbOpportunity", {
  live: {
    dex: "fakeDex1",
    router: "0xFakeRouter1",
    pairAddress: "0xFakePair1",
    tokenIn: tokens[0],
    tokenOut: tokens[1],
    priceImpactPct: 0.5,
    priceAfterImpact: 1.01,
    rawPrice: 1.0,
    liquidityUSD: 50000
  },
  catch: {
    dex: "fakeDex2",
    router: "0xFakeRouter2",
    pairAddress: "0xFakePair2",
    lowerPrice: 0.99,
    diffPct: 2.0,
    liquidityUSD: 60000
  },
  txHash: "0xFakeTxHash"
});

// Start the watcher (optional, will listen for real pending tx)
startBackrunWatcher()
  .then(() => console.log("👂 Watcher running in test mode..."))
  .catch((err) => console.error("❌ Watcher failed:", err));