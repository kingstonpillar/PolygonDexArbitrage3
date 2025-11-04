// backrunWatcher.js — listens directly to pendingTransaction.js WebSocket feed
import WebSocket from "ws";
import { EventEmitter } from "events";
import fs from "fs";
import "dotenv/config";
import { ethers } from "ethers";

import { getBalancerPoolReserves, getCurvePoolReserves } from "./balancercurve.js";
import { getKyberElasticReserves } from "./kyberelastic.js";
import { resolveV2V3Pairs } from "./v2v3resolver.js";
import { pairLiquidityUSD } from "./liquidity.js";
import { priceImpactEstimator } from "./priceImpactEstimator.js";

// === Routers map ===
const routers = JSON.parse(fs.readFileSync("./routers.json", "utf8"));
export const watcher = new EventEmitter();

// === SwapKind enum ===
export const SwapKind = {
  V2: 0,
  V3: 1,
  BALANCER: 2,
  CURVE: 3,
  KYBER: 4,
};

function getKindFromName(dexName) {
  const n = dexName.toLowerCase();
  if (n.includes("v3")) return SwapKind.V3;
  if (n.includes("balancer")) return SwapKind.BALANCER;
  if (n.includes("curve")) return SwapKind.CURVE;
  if (n.includes("kyber")) return SwapKind.KYBER;
  return SwapKind.V2;
}

function getHubTokens() {
  const lastToken =
    process.env.HUB_TOKEN_4 ||
    process.env.GAS_TOKEN ||
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // WMATIC default
  const tokens = [
    process.env.HUB_TOKEN_1,
    process.env.HUB_TOKEN_2,
    process.env.HUB_TOKEN_3,
    lastToken,
  ];
  return [...new Set(tokens.filter(Boolean).map((t) => t.toLowerCase()))];
}
export { getHubTokens };

function normalizeAmount(amount, decimals = 18) {
  if (typeof amount === "bigint") return Number(ethers.formatUnits(amount, decimals));
  return Number(amount);
}

// === Cache for pool reserves ===
const cacheTTL = 3000;
const reserveCache = new Map();
async function getCachedReserves(fn, key, _unused, args) {
  const now = Date.now();
  const cached = reserveCache.get(key);
  if (cached && now - cached.time < cacheTTL) return cached.data;
  const data = await fn(null, args);
  reserveCache.set(key, { data, time: now });
  return data;
}

// === Concurrency limiter ===
const MAX_CONCURRENT = 4;
let active = 0;
const queue = [];
async function limit(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    if (queue.length) queue.shift()();
  }
}

// === Seen tx cache ===
const seen = new Set();
function markTxSeen(txHash) {
  if (seen.has(txHash)) return false;
  seen.add(txHash);
  setTimeout(() => seen.delete(txHash), 10_000);
  return true;
}

export async function startBackrunWatcher() {
  console.log("🚀 Starting Backrun Watcher (via WebSocket feed)...");

  const hubTokens = getHubTokens();
  const url = "ws://127.0.0.1:7001";
  const STALE_TIMEOUT_MS = 15000;

  if (startBackrunWatcher._socket && startBackrunWatcher._socket.readyState === WebSocket.OPEN) {
    console.log("ℹ️ Backrun watcher socket already open, not reconnecting.");
    return;
  }

  const socket = new WebSocket(url);
  startBackrunWatcher._socket = socket;

  let feedActive = false;
  let lastMessageAt = Date.now();

  socket.on("open", () => {
    console.log(`✅ Connected to pendingTransaction.js feed (${url})`);
    console.log(`ℹ️ Routers loaded: ${Object.keys(routers).length}`);
  });

  // === Feed health monitor ===
  const stalenessTimer = setInterval(() => {
    const delta = Date.now() - lastMessageAt;
    if (delta > STALE_TIMEOUT_MS && feedActive) {
      console.warn("⏸️ Feed inactive for too long — pausing onchain queries.");
      feedActive = false;
    }
  }, STALE_TIMEOUT_MS).unref();

  socket.on("message", async (data) => {
    lastMessageAt = Date.now();
    let tx;

    try {
      const raw = typeof data === "string" ? data : data.toString();
      tx = JSON.parse(raw);
    } catch {
      return;
    }

    if (!tx?.hash || !tx?.to) return;
    if (!markTxSeen(tx.hash)) return;

    if (!feedActive) {
      feedActive = true;
      console.log("⚙️ Pending feed active — enabling onchain queries now.");
    }

    if (!feedActive) return;

    const txToLower = tx.to.toLowerCase();
    const routerEntry = Object.entries(routers).find(
      ([, r]) => r.address.toLowerCase() === txToLower
    );
    if (!routerEntry) return;

    const [liveDexName] = routerEntry;
    console.log(`🔔 Received router tx ${tx.hash.slice(0, 10)}... → ${liveDexName}`);

    await limit(async () => {
      await handleRouterTx(tx, liveDexName);
    });
  });

  socket.on("close", (code) => {
    clearInterval(stalenessTimer);
    console.warn(`🔴 Pending feed socket closed (${code || "no code"})`);
    startBackrunWatcher._socket = null;
  });

  socket.on("error", (err) => {
    console.error("⚠️ Pending feed socket error:", err.message || err);
  });

  // === Core heavy logic ===
  async function handleRouterTx(tx, liveDexName) {
    try {
      const liveKey = `live-${liveDexName}-${tx.to}`;
      let livePairs = [];

      if (liveDexName.includes("balancer")) {
        livePairs = await getCachedReserves(getBalancerPoolReserves, liveKey, null, [
          { pairAddress: tx.to, dex: liveDexName },
        ]);
      } else if (liveDexName.includes("curve")) {
        livePairs = await getCachedReserves(getCurvePoolReserves, liveKey, null, [
          { pairAddress: tx.to, dex: liveDexName },
        ]);
      } else if (liveDexName.includes("kyber")) {
        livePairs = await getCachedReserves(getKyberElasticReserves, liveKey, null, [
          { pairAddress: tx.to, dex: liveDexName },
        ]);
      } else {
        livePairs = await getCachedReserves(resolveV2V3Pairs, liveKey, null, tx.to, hubTokens);
      }

      if (!livePairs.length) return;

      const impacts = await Promise.all(
        livePairs.map((livePair) => {
          const decimals0 = livePair.decimals0 ?? 18;
          const decimals1 = livePair.decimals1 ?? 18;
          const liveRawPrice =
            normalizeAmount(livePair.reserve1, decimals1) /
            normalizeAmount(livePair.reserve0, decimals0);

          const amountIn = ethers.parseUnits("100", decimals0);

          return priceImpactEstimator({
            dexType: liveDexName,
            router: tx.to,
            tokenIn: livePair.token0,
            tokenOut: livePair.token1,
            reserves: livePair,
            pairAddress: livePair.pairAddress,
            amountIn,
            marketPrice: liveRawPrice,
          });
        })
      );

      for (let i = 0; i < livePairs.length; i++) {
        const livePair = livePairs[i];
        const impactData = impacts[i];
        const liquidityUSD = await pairLiquidityUSD(livePair);
        if (liquidityUSD < 300_000) continue;

        const stableTokens = ["USDT", "USDC"];
        const t0 = (livePair.symbol0 || "").toUpperCase();
        const t1 = (livePair.symbol1 || "").toUpperCase();
        if (!stableTokens.includes(t0) && !stableTokens.includes(t1)) continue;

        const livePrice =
          normalizeAmount(livePair.reserve1, livePair.decimals1 ?? 18) /
          normalizeAmount(livePair.reserve0, livePair.decimals0 ?? 18);

        const tasks = Object.entries(routers)
          .filter(([dex]) => dex !== liveDexName)
          .map(async ([otherDex, otherRouter]) => {
            const key = `catch-${otherDex}-${otherRouter.address}`;
            let pairs = [];

            if (otherDex.includes("balancer")) {
              pairs = await getCachedReserves(getBalancerPoolReserves, key, null, [
                { pairAddress: otherRouter.address, dex: otherDex },
              ]);
            } else if (otherDex.includes("curve")) {
              pairs = await getCachedReserves(getCurvePoolReserves, key, null, [
                { pairAddress: otherRouter.address, dex: otherDex },
              ]);
            } else if (otherDex.includes("kyber")) {
              pairs = await getCachedReserves(getKyberElasticReserves, key, null, [
                { pairAddress: otherRouter.address, dex: otherDex },
              ]);
            } else {
              pairs = await getCachedReserves(
                resolveV2V3Pairs,
                key,
                null,
                otherRouter.address,
                hubTokens
              );
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
                router: otherRouter.address,
              }))
              .filter((p) => p.liquidityUSD >= 300_000);
          });

        const catchPairs = (await Promise.all(tasks)).flat();

        let bestCatch = null;
        for (const c of catchPairs) {
          const diffPct = ((livePrice - c.catchRawPrice) / livePrice) * 100;
          if (diffPct >= 0.25 && (!bestCatch || diffPct > bestCatch.diffPct)) {
            bestCatch = { ...c, diffPct };
          }
        }

        if (bestCatch) {
          watcher.emit("arbOpportunity", {
            txHash: tx.hash,
            live: {
              dex: liveDexName,
              router: tx.to,
              kind: getKindFromName(liveDexName),
              pairAddress: livePair.pairAddress,
              tokenIn: livePair.token0,
              tokenOut: livePair.token1,
              priceImpactPct: impactData.priceImpactBps,
              priceAfterImpact: livePrice,
              liquidityUSD,
            },
            catch: {
              dex: bestCatch.dex,
              router: bestCatch.router,
              kind: getKindFromName(bestCatch.dex),
              pairAddress: bestCatch.pairAddress,
              lowerPrice: bestCatch.catchRawPrice,
              diffPct: bestCatch.diffPct,
              liquidityUSD: bestCatch.liquidityUSD,
            },
          });

          console.log(
            `[Emit] ${liveDexName} → ${bestCatch.dex} | Δ ${bestCatch.diffPct.toFixed(2)}%`
          );
        }
      }
    } catch (err) {
      console.error("❌ Error in handleRouterTx:", err.message);
    }
  }
}