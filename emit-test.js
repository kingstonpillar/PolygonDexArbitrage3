// emit-test.js
import { watcher } from "./backrunWatcher.js";

// ✅ Listen for emitted opportunities
watcher.on("arbOpportunity", (data) => {
  console.log("\n🚨 Arbitrage Opportunity Found (Test) 🚨");
  console.log("Live DEX:", data.live.dex);
  console.log("Catch DEX:", data.catch.dex);
  console.log("Δ Price %:", data.catch.diffPct.toFixed(3));
  console.log("Liquidity:", data.live.liquidityUSD.toFixed(2), "USD");
  console.log("TxHash:", data.txHash);
  console.log("--------------------------------------");
});

// ✅ Simulate a fake emit after a short delay
setTimeout(() => {
  watcher.emit("arbOpportunity", {
    live: {
      dex: "quickswap-v2",
      router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
      pairAddress: "0x123456789abcdef",
      tokenIn: "USDC",
      tokenOut: "WMATIC",
      priceImpactPct: 0.85,
      priceAfterImpact: 0.998,
      rawPrice: 1.002,
      liquidityUSD: 45000,
    },
    catch: {
      dex: "sushiswap-v2",
      router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      pairAddress: "0xabcdef123456789",
      lowerPrice: 0.987,
      diffPct: 1.15,
      liquidityUSD: 48000,
    },
    txHash: "0xFAKE1234567890ABCDEF",
  });
}, 2000);

console.log("🧠 Emit test started... (wait 2 seconds)");