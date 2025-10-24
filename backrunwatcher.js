// backrunWatcher.js — patched for BigInt-safe arithmetic
import { EventEmitter } from "node:events";
import fs from "fs";
import "dotenv/config";
import { ethers } from "ethers";

// === Helpers (all properly awaited) ===
import { getReadProvider } from "./helpers/dataprovider.js";
import { getBalancerPoolReserves, getCurvePoolReserves } from "./helpers/balancercurve.js";
import { getKyberElasticReserves } from "./helpers/kyberelastic.js";
import { resolveV2V3Pairs } from "./helpers/v2v3resolver.js";
import { pairLiquidityUSD } from "./helpers/liquidity.js";
import { priceImpactEstimator } from "./helpers/priceImpactEstimator.js";

// === Routers map ===
const routers = JSON.parse(fs.readFileSync("./routers.json", "utf8"));
export const watcher = new EventEmitter();

let provider;

// === Init Provider ===
async function initProvider() {
  if (!provider) provider = await getReadProvider();
}

// === Utility for Token Hub (include WMATIC dynamically) ===
function getHubTokens() {
  return [
    process.env.HUB_TOKEN_1 || "0x2791Bca1f2de4661ED88A30C99A7a944aA84174", // USDC
    process.env.HUB_TOKEN_2 || "0xc2132D05D31c914a87C6611C10748AaCB4FE7392", // USDT
    process.env.HUB_TOKEN_3 || "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", // DAI
    process.env.HUB_TOKEN_4 || "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"  // WMATIC
  ];
}

// --- Normalize BigInt/Number amounts to Number with decimals ---
function normalizeAmount(amount, decimals = 18) {
  if (typeof amount === "bigint") return Number(ethers.formatUnits(amount, decimals));
  return Number(amount);
}

// === Main Watcher ===
export async function startBackrunWatcher() {
  await initProvider();
  const hubTokens = getHubTokens();

  provider.on("pending", async (txHash) => {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx || !tx.to) return;

      const routerEntry = Object.entries(routers).find(
        ([, r]) => r.address.toLowerCase() === tx.to.toLowerCase()
      );
      if (!routerEntry) return;

      const [liveDexName, liveDexData] = routerEntry;

      // === Step 1: Fetch live pair(s) ===
      let livePairs = [];
      if (liveDexName.includes("balancer")) {
        livePairs = await getBalancerPoolReserves(provider, [{ pairAddress: tx.to, dex: liveDexName }]);
      } else if (liveDexName.includes("curve")) {
        livePairs = await getCurvePoolReserves(provider, [{ pairAddress: tx.to, dex: liveDexName }]);
      } else if (liveDexName.includes("kyber")) {
        livePairs = await getKyberElasticReserves(provider, [{ pairAddress: tx.to, dex: liveDexName }]);
      } else {
        livePairs = await resolveV2V3Pairs(tx.to, hubTokens, provider);
      }

      if (!livePairs.length) return;

      for (const livePair of livePairs) {
        // === Step 2: Estimate live price impact ===
        const impactData = await priceImpactEstimator(provider, tx, livePair);

        // === Step 3: Normalize reserves to Numbers (BigInt-safe) ===
        const decimals0 = livePair.decimals0 ?? 18;
        const decimals1 = livePair.decimals1 ?? 18;
        const reserve0 = normalizeAmount(livePair.reserve0, decimals0);
        const reserve1 = normalizeAmount(livePair.reserve1, decimals1);

        const liveRawPrice = reserve1 / reserve0;

        // === Step 4: Liquidity check (awaited) ===
        const liquidityUSD = await pairLiquidityUSD(livePair);
        if (liquidityUSD < 30_000) {
          console.log(`[Skip] ${liveDexName} liquidity ${liquidityUSD.toFixed(2)} USD`);
          continue;
        }

        // === Step 5: Search catch DEX for same token pair ===
        const tasks = Object.entries(routers)
          .filter(([otherDex]) => otherDex !== liveDexName)
          .map(async ([otherDex, otherRouter]) => {
            let pairs = [];
            if (otherDex.includes("balancer")) {
              pairs = await getBalancerPoolReserves(provider, [{ pairAddress: otherRouter.address, dex: otherDex }]);
            } else if (otherDex.includes("curve")) {
              pairs = await getCurvePoolReserves(provider, [{ pairAddress: otherRouter.address, dex: otherDex }]);
            } else if (otherDex.includes("kyber")) {
              pairs = await getKyberElasticReserves(provider, [{ pairAddress: otherRouter.address, dex: otherDex }]);
            } else {
              pairs = await resolveV2V3Pairs(otherRouter.address, hubTokens, provider);
            }

            // Related token match
            const relatedPairs = pairs.filter(
              (p) =>
                [p.token0, p.token1].includes(livePair.token0) &&
                [p.token0, p.token1].includes(livePair.token1)
            );

            // Apply liquidity filter & normalize reserves
            const filteredPairs = [];
            for (const p of relatedPairs) {
              const liq = await pairLiquidityUSD(p);
              if (liq >= 30_000) {
                const dec0 = p.decimals0 ?? 18;
                const dec1 = p.decimals1 ?? 18;
                filteredPairs.push({
                  ...p,
                  liquidityUSD: liq,
                  catchRawPrice: normalizeAmount(p.reserve1, dec1) / normalizeAmount(p.reserve0, dec0),
                  dex: otherDex,
                  router: otherRouter.address
                });
              }
            }

            return filteredPairs;
          });

        const catchPairs = (await Promise.all(tasks)).flat();

        // === Step 6: Find best catch opportunity (>1% diff) ===
        const livePrice = impactData.priceAfterImpact;
        let bestCatch = null;

        for (const c of catchPairs) {
          const catchPrice = Number(c.price || c.catchRawPrice);
          if (!catchPrice) continue;

          const diffPct = ((livePrice - catchPrice) / livePrice) * 100;
          if (diffPct >= 1 && (!bestCatch || diffPct > bestCatch.diffPct)) {
            bestCatch = { ...c, diffPct };
          }
        }

        // === Step 7: Emit results with raw prices ===
        if (bestCatch) {
          watcher.emit("arbOpportunity", {
            live: {
              dex: liveDexName,
              router: liveDexData.address,
              pairAddress: livePair.pairAddress,
              tokenIn: livePair.token0,
              tokenOut: livePair.token1,
              priceImpactPct: impactData.impactPct,
              priceAfterImpact: livePrice,
              rawPrice: liveRawPrice,
              liquidityUSD
            },
            catch: {
              dex: bestCatch.dex,
              router: bestCatch.router,
              pairAddress: bestCatch.pairAddress,
              lowerPrice: bestCatch.catchRawPrice,
              diffPct: bestCatch.diffPct,
              liquidityUSD: bestCatch.liquidityUSD
            },
            txHash
          });

          console.log(`[Emit] ${liveDexName} → ${bestCatch.dex} | Δ ${bestCatch.diffPct.toFixed(2)}%`);
        }
      }
    } catch (err) {
      console.error(`[Watcher Error] ${err.message}`);
    }
  });

  console.log("[Watcher] 🔍 Listening for pending transactions...");
}