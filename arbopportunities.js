// arbopportunities-batch.js
import fs from "fs";
import { watcher } from "./backrunwatcher.js";
import { sendTelegram } from "./telegramalert.js";

const DIRECT_POOL_FILE = "./direct_pool.json";

// --- JSON helpers (atomic write) ---
function safeReadJson() {
  try {
    if (!fs.existsSync(DIRECT_POOL_FILE)) return [];
    const content = fs.readFileSync(DIRECT_POOL_FILE, "utf8");
    return content ? JSON.parse(content) : [];
  } catch {
    return [];
  }
}

function writeJsonAtomic(data) {
  const tmpFile = `${DIRECT_POOL_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DIRECT_POOL_FILE);
}

// --- Pending batching ---
let pendingPools = [];
let flushTimeout = null;
const FLUSH_INTERVAL = 10; // ms

function scheduleFlush() {
  if (flushTimeout) return;
  flushTimeout = setTimeout(() => {
    const currentPools = safeReadJson();
    writeJsonAtomic([...currentPools, ...pendingPools]);
    console.log(`📥 Flushed ${pendingPools.length} new arbitrages`);
    pendingPools = [];
    flushTimeout = null;
  }, FLUSH_INTERVAL);
}

// --- Normalization helper ---
function sanitizePool(pool) {
  return {
    ...pool,
    profitUSD: Number(pool.profitUSD),
    timestamp: Number(pool.timestamp),
  };
}

// === Event listener ===
watcher.on("arbOpportunity", async (data) => {
  try {
    const tokenIn = data.live?.tokenIn || "";
    const tokenOut = data.live?.tokenOut || "";
    const pairSymbol = `${tokenIn.slice(0, 6)}.../${tokenOut.slice(0, 6)}...`;

    const rawProfitUSD = data.catch.diffPct * (data.live.liquidityUSD / 100);

    // ✅ Use tokenIn/tokenOut directly
    const newPool = sanitizePool({
      pairSymbol,
      tokenIn,
      tokenOut,
      liveDex: {
        name: data.live?.dex,
        router: data.live?.router,
        kind: data.live?.kind ?? 0,
        pairAddress: data.live?.pairAddress ?? null,
      },
      catchDex: {
        name: data.catch?.dex,
        router: data.catch?.router,
        kind: data.catch?.kind ?? 0,
        pairAddress: data.catch?.pairAddress ?? null,
      },
      diffPct: data.catch?.diffPct ?? 0,
      liquidityUSD: data.live?.liquidityUSD ?? 0,
      profitUSD: rawProfitUSD,
      txHash: data.txHash,
      timestamp: Date.now(),
    });

    pendingPools.push(newPool);
    scheduleFlush();

    console.log(
      `🟢 Queued new arbitrage: ${pairSymbol} | ` +
      `${data.live.dex} (kind=${data.live.kind}) → ${data.catch.dex} (kind=${data.catch.kind}) | Δ ${data.catch.diffPct.toFixed(2)}%`
    );

    await sendTelegram(
      `💹 New Arb Opportunity\n${pairSymbol}\n` +
      `${data.live.dex} → ${data.catch.dex}\nΔ ${data.catch.diffPct.toFixed(2)}%`
    );
  } catch (err) {
    console.error("[arbopportunities-batch] Error:", err.message);
    await sendTelegram(`⚠️ ArbOpportunity error: ${err.message}`);
  }
});