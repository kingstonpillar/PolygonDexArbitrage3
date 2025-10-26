// arbopportunities-batch.js
import fs from "fs";
import { watcher } from "./backrunwatcher.js";
import { sendTelegram } from "./telegramalert.js";

const DIRECT_POOL_FILE = "./direct_pool.json";

// Atomic JSON helpers
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

// === Pending queue for batching ===
let pendingPools = [];
let flushTimeout = null;
const FLUSH_INTERVAL = 10; // milliseconds

function scheduleFlush() {
  if (flushTimeout) return; // already scheduled
  flushTimeout = setTimeout(() => {
    const currentPools = safeReadJson();
    writeJsonAtomic([...currentPools, ...pendingPools]);
    console.log(`📥 Flushed ${pendingPools.length} new arbitrages`);
    pendingPools = [];
    flushTimeout = null;
  }, FLUSH_INTERVAL);
}

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
    const id = `arb-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const tokenIn = data.live?.tokenIn || "";
    const tokenOut = data.live?.tokenOut || "";
    const pairSymbol = `${tokenIn.slice(0, 6)}.../${tokenOut.slice(0, 6)}...`;

    const rawProfitUSD = data.catch.diffPct * (data.live.liquidityUSD / 100);

    const newPool = sanitizePool({
      id,
      pairSymbol,
      liveDex: data.live,
      catchDex: data.catch,
      profitUSD: rawProfitUSD,
      timestamp: Date.now(),
    });

    pendingPools.push(newPool);
    scheduleFlush();

    console.log(`🟢 Queued new arbitrage: ${pairSymbol}`);
    await sendTelegram(
      `💹 New Arb Opportunity\n${pairSymbol}\nDiff: ${data.catch.diffPct.toFixed(2)}%`
    );
  } catch (err) {
    console.error("[arbopportunities-batch] Error:", err.message);
    await sendTelegram(`⚠️ ArbOpportunity error: ${err.message}`);
  }
});