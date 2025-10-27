// poolexecutor-concurrent.js
import fs from "fs";
import { protectionutilities } from "./protectionutilities.js";
import { broadcastPendingPool } from "./broadcast.js";
import { sendTelegram } from "./telegramalert.js";
import { getRealSlippage } from "./slippagehelper.js";
import { getRealGasCostUSD } from "./gashelper.js";

const DIRECT_POOL_FILE = "./direct_pool.json";

// === JSON Helpers (atomic) ===
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

function removePoolById(id) {
  const pools = safeReadJson().filter(p => p.id !== id);
  writeJsonAtomic(pools);
}

// === Single Pool Executor ===
async function executeSinglePool(pool) {
  try {
    const prot = await protectionutilities(pool, pool.profitUSD);
    if (!prot?.ok) {
      await sendTelegram(`⚠️ Protection blocked ${pool.liveDex?.pairAddress || "Unknown"}: ${prot?.reason || "Unknown"}`);
      removePoolById(pool.id);
      return;
    }

    const buyFrom = pool.catchDex || pool.catch;
    const sellTo = pool.liveDex || pool.live;

    // Loan asset detection
    let loanAsset = "USDC";
    const symbol = pool.pairSymbol?.toUpperCase() || "";
    if (symbol.includes("USDT")) loanAsset = "USDT";
    else if (symbol.includes("DAI")) loanAsset = "DAI";
    else if (symbol.includes("WMATIC")) loanAsset = "WMATIC";
    else if (symbol.includes("WETH")) loanAsset = "WETH";

    const liqUSD = Math.min(buyFrom.liquidityUSD ?? 0, sellTo.liquidityUSD ?? 0);

    // Slippage / Gas estimates
    const gasCostUSD = await getRealGasCostUSD(liqUSD);
    const liveSlip = await getRealSlippage(sellTo.name, sellTo.tokenIn, sellTo.tokenOut);
    const catchSlip = await getRealSlippage(buyFrom.name, buyFrom.tokenIn, buyFrom.tokenOut);
    const slippagePct = Math.max(liveSlip, catchSlip);
    const slippageUSD = (liqUSD * slippagePct) / 100;

    if (slippagePct > 1.5) {
      await sendTelegram(`⚠️ Skipped ${symbol} — Slippage too high (${slippagePct.toFixed(3)}%)`);
      removePoolById(pool.id);
      return;
    }

    const sellPrice = Number(sellTo?.priceAfterImpact ?? 0);
    const buyPrice = Number(buyFrom?.catchPrice ?? 0);
    if (sellPrice <= 0 || buyPrice <= 0) {
      await sendTelegram(`⚠️ Skipped ${symbol} — Invalid price data`);
      removePoolById(pool.id);
      return;
    }

    const priceDiffPct = ((sellPrice - buyPrice) / buyPrice) * 100;
    const profitUSD = pool.profitUSD || liqUSD * (priceDiffPct / 100);
    const estProfitUSD = profitUSD - gasCostUSD - slippageUSD;

    if (estProfitUSD < Number(process.env.MIN_PROFIT_USD || 10)) {
      await sendTelegram(`⚠️ Skipped ${symbol} — Profit too low: ${estProfitUSD.toFixed(2)} USD`);
      removePoolById(pool.id);
      return;
    }

    // ✅ Enrich pool with kind for Solidity enum compatibility
    const id = pool.id || `arb-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const enrichedPool = {
      ...pool,
      id,
      loanAsset,
      loanAmountUSD: liqUSD * 0.02,
      gasCostUSD,
      slippageUSD,
      estProfitUSD,
      buyDex: buyFrom.name,
      sellDex: sellTo.name,
      buyRouter: buyFrom.router,
      sellRouter: sellTo.router,
      buyKind: buyFrom.kind ?? 0,   // <-- Kind for buy side (e.g. V2, V3, BALANCER...)
      sellKind: sellTo.kind ?? 0,   // <-- Kind for sell side
      buyPair: buyFrom.pairAddress,
      sellPair: sellTo.pairAddress,
      priceDiffPct,
      liveSlippage: liveSlip,
      catchSlippage: catchSlip,
    };

    // Update JSON atomically
    const pools = safeReadJson().map(p => (p.id === id ? enrichedPool : p));
    writeJsonAtomic(pools);
    console.log(`✅ Pool enriched: ${symbol || id}`);

    // Broadcast
    const result = await broadcastPendingPool(enrichedPool);
    if (result?.status === "submitted") {
      console.log(`🚀 Broadcast submitted ${symbol}: ${result.txHash}`);
      await sendTelegram(`🚀 Broadcast submitted ${symbol} | tx: ${result.txHash}`);
    } else {
      console.warn(`⚠️ Broadcast failed ${symbol}: ${result?.reason || "Unknown"}`);
      await sendTelegram(`⚠️ Broadcast failed ${symbol}: ${result?.reason || "Unknown"}`);
    }

    removePoolById(id);

  } catch (e) {
    console.error(`[PoolExecutor] Error ${pool.pairSymbol}:`, e.message);
    await sendTelegram(`🛑 Fatal error executing ${pool.pairSymbol}: ${e.message}`);
    removePoolById(pool.id);
  }
}

// === Concurrent Executor for Multiple Pools ===
export async function executePoolsConcurrently(pools) {
  await Promise.all(pools.map(pool => executeSinglePool(pool)));
}