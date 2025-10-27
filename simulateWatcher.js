// simulateWatcher.js
// A test harness that emits arbOpportunity events into your backrun watcher
// and forwards them to broadcastPendingPool (real or mock).
//
// Usage: NODE_OPTIONS=--experimental-json-modules node simulateWatcher.js
// Requires: backrunWatcher.js to export `watcher` (EventEmitter) OR uses a small internal emitter.

import { watcher as realWatcher } from "./backrunWatcher.js";
import { broadcastPendingPool as realBroadcast } from "./broadcast.js"; // try real first
import { broadcastPendingPool as mockBroadcast } from "./broadcast_mock_or_real.js";
import { ethers } from "ethers";

const WATCHER = realWatcher || { on: () => {}, emit: () => {} };
const BROADCAST = typeof realBroadcast === "function" ? realBroadcast : mockBroadcast;

// helper for timestamps
const nowMs = () => new Date().toISOString();

// generate sample routers (addresses are fake but shape matters)
const sampleRouters = {
  sushi: "0xSushi000000000000000000000000000000000000",
  uniswapv3: "0xUniswapV30000000000000000000000000000000",
  balancerVault: "0xBalancer00000000000000000000000000000000",
  curvePool: "0xCurve000000000000000000000000000000000000",
  kyber: "0xKyber000000000000000000000000000000000000"
};

// utility to create a pool object matching your broadcast shape
function makePool({ idSuffix = "", liveDex = "sushi", catchDex = "uniswapv3", loanAsset = "0x0000000000000000000000000000000000000001", loanEth = "1000" }) {
  // amount in wei
  const loanAmountWei = ethers.parseUnits(String(loanEth), 18);

  const liveRouter = sampleRouters[liveDex] || sampleRouters.sushi;
  const catchRouter = sampleRouters[catchDex] || sampleRouters.uniswapv3;

  // pick kinds consistent with getKindFromName mapping
  const kindMap = { sushi: 0, uniswapv3: 1, balancer: 2, curve: 3, kyber: 4 };
  const pool = {
    id: `test-${Date.now()}-${Math.floor(Math.random() * 10000)}${idSuffix}`,
    pairSymbol: "TOK/USDC",
    loanAsset: loanAsset,
    loanAmount: loanAmountWei.toString(), // keep as string numeric digits
    tokenIn: loanAsset,
    tokenOut: "0x0000000000000000000000000000000000000002",
    buyRouter: catchRouter,
    sellRouter: liveRouter,
    buyKind: kindMap[catchDex] ?? 0,
    sellKind: kindMap[liveDex] ?? 0,
    minOut: ethers.parseUnits("0", 18).toString(),
    minIn: ethers.parseUnits("0", 18).toString(),
    v3Fee: 3000,
    poolId: "0x",
    poolIdBytes: "0x",
    profitUSD: 200,
    estProfitUSD: 200,
    catch: {
      dex: catchDex,
      router: catchRouter,
      pairAddress: "0xCATCHPAIR000000000000000000000000000000"
    },
    live: {
      dex: liveDex,
      router: liveRouter,
      pairAddress: "0xLIVEPAIR00000000000000000000000000000000",
      liquidityUSD: 100_000,
      priceAfterImpact: 1.01
    }
  };

  return pool;
}

// Emit a stream of synthetic opportunities with random timing and variations.
async function startEmitter({ ratePerSecond = 2, durationSec = 20 } = {}) {
  console.log(`${nowMs()} [sim] Starting emitter: ${ratePerSecond} events/sec for ${durationSec}s`);
  const total = Math.max(1, Math.floor(ratePerSecond * durationSec));
  let emitted = 0;

  const intervalMs = Math.floor(1000 / ratePerSecond);
  const stopAt = Date.now() + durationSec * 1000;

  while (Date.now() < stopAt && emitted < total) {
    const liveDex = Math.random() < 0.4 ? "sushi" : (Math.random() < 0.2 ? "uniswapv3" : (Math.random() < 0.1 ? "balancer" : "curve"));
    const catchDex = liveDex === "sushi" ? "uniswapv3" : "sushi";
    const pool = makePool({ idSuffix: `-${emitted}`, liveDex, catchDex, loanEth: (50 + Math.floor(Math.random() * 950)).toString() });

    // timestamp before emit
    const emittedAt = Date.now();
    // emit via watcher (simulate the real watcher)
    if (realWatcher && typeof realWatcher.emit === "function") {
      realWatcher.emit("arbOpportunity", {
        live: { dex: pool.live.dex, router: pool.live.router, kind: pool.sellKind, pairAddress: pool.live.pairAddress, tokenIn: pool.tokenIn, tokenOut: pool.tokenOut, priceAfterImpact: pool.live.priceAfterImpact, liquidityUSD: pool.live.liquidityUSD },
        catch: { dex: pool.catch.dex, router: pool.catch.router, kind: pool.buyKind, pairAddress: pool.catch.pairAddress, lowerPrice: 1.0, diffPct: 1.5, liquidityUSD: 50000 },
        txHash: `0xSIM${emitted.toString().padStart(6,"0")}`
      });
    }

    // Immediately forward to broadcastPendingPool to test end-to-end
    (async () => {
      const start = Date.now();
      console.log(`${nowMs()} [sim] -> broadcasting pool ${pool.id} live=${pool.live.dex} catch=${pool.catch.dex}`);
      try {
        const res = await BROADCAST(pool);
        const took = Date.now() - start;
        console.log(`${nowMs()} [sim] <- broadcast result for ${pool.id}:`, res, `took=${took}ms (emit->start=${start-emittedAt}ms)`);
      } catch (err) {
        console.error(`${nowMs()} [sim] BROADCAST threw for ${pool.id}:`, err.message);
      }
    })();

    emitted++;
    await new Promise(r => setTimeout(r, intervalMs + Math.floor(Math.random() * intervalMs)));
  }

  console.log(`${nowMs()} [sim] Emitter complete. emitted=${emitted}`);
}

// If user wants to listen to real watcher events and forward them, wire it up:
if (realWatcher && typeof realWatcher.on === "function") {
  realWatcher.on("arbOpportunity", async (data) => {
    console.log(`${nowMs()} [sim] received arbOpportunity from real watcher: live=${data.live.dex} catch=${data.catch.dex}`);
    try {
      const start = Date.now();
      const res = await BROADCAST(data);
      console.log(`${nowMs()} [sim] real->broadcast result:`, res, `took=${Date.now()-start}ms`);
    } catch (e) {
      console.error(`${nowMs()} [sim] real->broadcast error:`, e.message);
    }
  });
}

// CLI control
const argv = process.argv.slice(2);
const rIndex = argv.findIndex(a => a === "--rate");
const dIndex = argv.findIndex(a => a === "--duration");
const rate = rIndex >= 0 ? Number(argv[rIndex+1] || 2) : 2;
const duration = dIndex >= 0 ? Number(argv[dIndex+1] || 20) : 20;

startEmitter({ ratePerSecond: rate, durationSec: duration }).catch(e => console.error("[sim] fatal:", e));