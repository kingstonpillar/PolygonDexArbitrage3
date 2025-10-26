// backrunWatcher.js — micro-optimized concurrent version
import { EventEmitter } from "node:events";
import fs from "fs";
import "dotenv/config";
import { ethers } from "ethers";

import { getReadProvider } from "./dataprovider.js";
import { getBalancerPoolReserves, getCurvePoolReserves } from "./balancercurve.js";
import { getKyberElasticReserves } from "./kyberelastic.js";
import { resolveV2V3Pairs } from "./v2v3resolver.js";
import { pairLiquidityUSD } from "./liquidity.js";
import { priceImpactEstimator } from "./priceImpactEstimator.js";

// === Routers map ===
const routers = JSON.parse(fs.readFileSync("./routers.json", "utf8"));
export const watcher = new EventEmitter();

let provider;

// === Provider Init ===
async function initProvider() {
  if (!provider) provider = await getReadProvider(); // must return WebSocket provider
}

// === Tokens ===
function getHubTokens() {
  const lastToken =
    process.env.HUB_TOKEN_4 ||
    process.env.GAS_TOKEN ||
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // WMATIC default

  const tokens = [
    process.env.HUB_TOKEN_1,
    process.env.HUB_TOKEN_2,
    process.env.HUB_TOKEN_3,
    lastToken
  ];
  return [...new Set(tokens.filter(Boolean).map(t => t.toLowerCase()))];
}

export { getHubTokens };

// === Normalizer ===
function normalizeAmount(amount, decimals = 18) {
  if (typeof amount === "bigint") return Number(ethers.formatUnits(amount, decimals));
  return Number(amount);
}

// === Caching system for reserves & liquidity ===
const cacheTTL = 3000; // 3 seconds
const reserveCache = new Map();

async function getCachedReserves(fn, key, provider, args) {
  const now = Date.now();
  const cached = reserveCache.get(key);
  if (cached && now - cached.time < cacheTTL) return cached.data;
  const data = await fn(provider, args);
  reserveCache.set(key, { data, time: now });
  return data;
}

// === Concurrency limiter (to protect RPC) ===
const MAX_CONCURRENT = 4;
let active = 0;
const queue = [];

async function limit(fn) {
  if (active >= MAX_CONCURRENT)
    await new Promise(res => queue.push(res));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    if (queue.length) queue.shift()();
  }
}

// === Seen tx cache (avoid duplicate processing) ===
const seen = new Set();
function markTxSeen(txHash) {
  if (seen.has(txHash)) return false;
  seen.add(txHash);
  setTimeout(() => seen.delete(txHash), 10_000);
  return true;
}

// === Main Watcher ===
export async function startBackrunWatcher() {
  await initProvider();
  const hubTokens = getHubTokens();

  provider.on("pending", async (txHash) => {
  if (!markTxSeen(txHash)) return;

  try {
    await limit(async () => {
      try {
        const tx = await provider.getTransaction(txHash);
        if (!tx || !tx.to) return;

        const routerEntry = Object.entries(routers).find(
          ([, r]) => r.address.toLowerCase() === tx.to.toLowerCase()
        );
        if (!routerEntry) return;

        const [liveDexName, liveDexData] = routerEntry;

        // === Step 1: Fetch live pair(s) fast via cache ===
        let livePairs = [];
        const liveKey = `live-${liveDexName}-${tx.to}`;
        if (liveDexName.includes("balancer")) {
          livePairs = await getCachedReserves(getBalancerPoolReserves, liveKey, provider, [{ pairAddress: tx.to, dex: liveDexName }]);
        } else if (liveDexName.includes("curve")) {
          livePairs = await getCachedReserves(getCurvePoolReserves, liveKey, provider, [{ pairAddress: tx.to, dex: liveDexName }]);
        } else if (liveDexName.includes("kyber")) {
          livePairs = await getCachedReserves(getKyberElasticReserves, liveKey, provider, [{ pairAddress: tx.to, dex: liveDexName }]);
        } else {
          livePairs = await getCachedReserves(resolveV2V3Pairs, liveKey, provider, tx.to, hubTokens);
        }

        if (!livePairs.length) return;

        // === Step 2: Compute price impact for all livePairs concurrently ===
        const impacts = await Promise.all(
          livePairs.map(livePair => {
            const decimals0 = livePair.decimals0 ?? 18;
            const decimals1 = livePair.decimals1 ?? 18;
            const liveRawPrice = normalizeAmount(livePair.reserve1, decimals1) / normalizeAmount(livePair.reserve0, decimals0);

            return priceImpactEstimator({
              dexType: liveDexName,
              router: liveDexData.address,
              tokenIn: livePair.token0,
              tokenOut: livePair.token1,
              reserves: livePair,
              pairAddress: livePair.pairAddress,
              amountIn: ethers.parseUnits("100", decimals0),
              marketPrice: liveRawPrice
            });
          })
        );

        // === Step 3: Iterate each pair + impact result ===
        for (let i = 0; i < livePairs.length; i++) {
          const livePair = livePairs[i];
          const impactData = impacts[i];

          const liquidityUSD = await pairLiquidityUSD(livePair);
          if (liquidityUSD < 30_000) continue;

          const livePrice = normalizeAmount(livePair.reserve1, livePair.decimals1 ?? 18) /
                            normalizeAmount(livePair.reserve0, livePair.decimals0 ?? 18);

          // === Step 4: Check other Dexes for arbitrage ===
          const tasks = Object.entries(routers)
            .filter(([dex]) => dex !== liveDexName)
            .map(async ([otherDex, otherRouter]) => {
              const key = `catch-${otherDex}-${otherRouter.address}`;
              let pairs = [];

              if (otherDex.includes("balancer")) {
                pairs = await getCachedReserves(getBalancerPoolReserves, key, provider, [{ pairAddress: otherRouter.address, dex: otherDex }]);
              } else if (otherDex.includes("curve")) {
                pairs = await getCachedReserves(getCurvePoolReserves, key, provider, [{ pairAddress: otherRouter.address, dex: otherDex }]);
              } else if (otherDex.includes("kyber")) {
                pairs = await getCachedReserves(getKyberElasticReserves, key, provider, [{ pairAddress: otherRouter.address, dex: otherDex }]);
              } else {
                pairs = await getCachedReserves(resolveV2V3Pairs, key, provider, otherRouter.address, hubTokens);
              }

              const related = pairs.filter(
                (p) =>
                  [p.token0, p.token1].includes(livePair.token0) &&
                  [p.token0, p.token1].includes(livePair.token1)
              );

              const liqs = await Promise.all(related.map(pairLiquidityUSD));
              return related
                .map((p, i) => ({
                  ...p,
                  liquidityUSD: liqs[i],
                  catchRawPrice:
                    normalizeAmount(p.reserve1, p.decimals1 ?? 18) /
                    normalizeAmount(p.reserve0, p.decimals0 ?? 18),
                  dex: otherDex,
                  router: otherRouter.address
                }))
                .filter((p) => p.liquidityUSD >= 30_000);
            });

          const catchPairs = (await Promise.all(tasks)).flat();

          let bestCatch = null;
          for (const c of catchPairs) {
            const diffPct = ((livePrice - c.catchRawPrice) / livePrice) * 100;
            if (diffPct >= 1 && (!bestCatch || diffPct > bestCatch.diffPct)) {
              bestCatch = { ...c, diffPct };
            }
          }

          if (bestCatch) {
            watcher.emit("arbOpportunity", {
              live: {
                dex: liveDexName,
                router: liveDexData.address,
                pairAddress: livePair.pairAddress,
                tokenIn: livePair.token0,
                tokenOut: livePair.token1,
                priceImpactPct: impactData.priceImpactBps,
                priceAfterImpact: livePrice,
                rawPrice: livePrice,
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
  } catch (outerErr) {
    console.error(`[Pending Event Error] ${outerErr.message}`);
  }
});