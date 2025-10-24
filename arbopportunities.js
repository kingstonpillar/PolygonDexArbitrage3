// arbopportunities.js — with sanity conversion wrapper
import fs from "fs";
import { watcher } from "./backrunwatcher.js";
import { sendTelegram } from "./telegramalert.js";
import { ethers } from "ethers"; // for safe conversion

const DIRECT_POOL_FILE = "./direct_pool.json";

function safeReadJson() {
  try {
    if (!fs.existsSync(DIRECT_POOL_FILE)) return [];
    const content = fs.readFileSync(DIRECT_POOL_FILE, "utf8");
    return content ? JSON.parse(content) : [];
  } catch {
    return [];
  }
}

function writeJson(data) {
  fs.writeFileSync(DIRECT_POOL_FILE, JSON.stringify(data, null, 2));
}

/**
 * Sanitize numeric fields: convert BigInt / ethers values to float
 */
function sanitizePool(pool) {
  return {
    ...pool,
    profitUSD: Number(pool.profitUSD),
    timestamp: Number(pool.timestamp),
  };
}

watcher.on("arbOpportunity", async (data) => {
  try {
    const pools = safeReadJson();

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

    pools.push(newPool);
    writeJson(pools);

    console.log(`📥 Stored new arbitrage: ${pairSymbol}`);
    await sendTelegram(
      `💹 New Arb Opportunity\n${pairSymbol}\nDiff: ${data.catch.diffPct.toFixed(2)}%`
    );

  } catch (err) {
    console.error("[arbopportunities] Error:", err.message);
    await sendTelegram(`⚠️ ArbOpportunity error: ${err.message}`);
  }
});