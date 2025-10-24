// poolexecutor.js — WebSocket + atomic cleanup version
import fs from "fs";
import dotenv from "dotenv";
import { ethers } from "ethers";
import { protectionutilities } from "./protectionutilities.js"; // ✅ only await
import { broadcastPendingPool } from "./broadcast.js";
import { sendTelegram } from "./telegramalert.js";
import { getRealSlippage } from "./slippagehelper.js";
import { getRealGasCostUSD } from "./gashelper.js";

dotenv.config();

const DIRECT_POOL_FILE = "./direct_pool.json";

// === ENV CONFIG ===
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 10);
const LOAN_PCT_DEFAULT = Number(process.env.LOAN_PCT_DEFAULT || 0.02);
const LOAN_PCT_MID = Number(process.env.LOAN_PCT_MID || 0.008);
const LOAN_PCT_HIGH = Number(process.env.LOAN_PCT_HIGH || 0.005);
const RPC_WS = process.env.RPC_WS_URL || "";

// === JSON Helpers ===
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

function removePoolById(id) {
  const pools = safeReadJson().filter((p) => p.id !== id);
  writeJson(pools);
}

// === Core Executor ===
export async function executePool(pool) {
  try {
    // 🛡️ Only await protectionutilities — no fake exports
    const prot = await protectionutilities(pool, pool.profitUSD);
    if (!prot || !prot.ok) {
      await sendTelegram(
        `🛡️ Protection blocked ${pool.live?.pairAddress || "Unknown"}: ${prot?.reason || "Unknown"}`
      );
      removePoolById(pool.id);
      return;
    }

    // 🧭 Direction — BUY from catch, SELL to live
    const buyFrom = pool.catch;
    const sellTo = pool.live;

    // 💰 Loan asset detection
    let loanAsset = "USDC";
    const symbol = pool.pairSymbol?.toUpperCase() || "";
    if (symbol.includes("USDT")) loanAsset = "USDT";
    else if (symbol.includes("DAI")) loanAsset = "DAI";
    else if (symbol.includes("WMATIC")) loanAsset = "WMATIC";
    else if (symbol.includes("WETH")) loanAsset = "WETH";

    // 💧 Liquidity logic
    const liqUSD = Math.min(buyFrom.liquidityUSD, sellTo.liquidityUSD);
    let loanPct = LOAN_PCT_DEFAULT;
    if (liqUSD > 200_000) loanPct = LOAN_PCT_MID;
    if (liqUSD > 500_000) loanPct = LOAN_PCT_HIGH;
    const loanAmountUSD = liqUSD * loanPct;

    // ⛽ Gas estimation
    const gasCostUSD = await getRealGasCostUSD(liqUSD);

    // ⚙️ Dynamic slippage
    const liveSlip = await getRealSlippage(sellTo.dex, sellTo.tokenIn, sellTo.tokenOut);
    const catchSlip = await getRealSlippage(buyFrom.dex, buyFrom.tokenIn, buyFrom.tokenOut);
    const slippagePct = Math.max(liveSlip, catchSlip);
    const slippageUSD = (liqUSD * slippagePct) / 100;

    if (slippagePct > 1.5) {
      await sendTelegram(`⚠️ Skipped ${symbol} — Slippage too high (${slippagePct.toFixed(3)}%)`);
      removePoolById(pool.id);
      return;
    }

    // 💵 Profit validation
    const sellPrice = Number(sellTo?.priceAfterImpact ?? 0);
    const buyPrice = Number(buyFrom?.catchPrice ?? 0);
    if (sellPrice <= 0 || buyPrice <= 0) {
      await sendTelegram(`⚠️ Skipped ${symbol} — Invalid price data`);
      removePoolById(pool.id);
      return;
    }

    const priceDiffPct = ((sellPrice - buyPrice) / buyPrice) * 100;
    const profitUSD = pool.profitUSD || (liqUSD * (priceDiffPct / 100));
    const estProfitUSD = profitUSD - gasCostUSD - slippageUSD;

    if (estProfitUSD < MIN_PROFIT_USD) {
      await sendTelegram(`⚠️ Skipped ${symbol} — Profit too low: ${estProfitUSD.toFixed(2)} USD`);
      removePoolById(pool.id);
      return;
    }

    // 🆔 Assign ID
    const id = pool.id || `arb-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // 🧮 Convert loanAmountUSD → token units
    const ERC20_ABI = ["function decimals() view returns (uint8)"];
    const provider = new ethers.WebSocketProvider(RPC_WS);
    const tokenContract = new ethers.Contract(loanAsset, ERC20_ABI, provider);
    const decimals = await tokenContract.decimals();
    const loanAmount = ethers.parseUnits(loanAmountUSD.toFixed(decimals), decimals);

    // 💾 Enrich pool
    const enrichedPool = {
      ...pool,
      id,
      loanAsset,
      loanAmount,
      loanAmountUSD,
      gasCostUSD,
      slippageUSD,
      estProfitUSD,
      buyDex: buyFrom.dex,
      sellDex: sellTo.dex,
      buyRouter: buyFrom.router,
      sellRouter: sellTo.router,
      buyPair: buyFrom.pairAddress,
      sellPair: sellTo.pairAddress,
      priceDiffPct,
      liveSlippage: liveSlip,
      catchSlippage: catchSlip,
    };

    // ✍️ Update JSON
    const pools = safeReadJson().map((p) => (p.id === id ? enrichedPool : p));
    writeJson(pools);
    console.log(`💾 Pool enriched and ready: ${pool.pairSymbol || id}`);

    // 🚀 Broadcast
    const result = await broadcastPendingPool(enrichedPool);
    if (result?.status === "submitted") {
      console.log(`✅ Broadcast submitted ${pool.pairSymbol}: ${result.txHash}`);
      await sendTelegram(`✅ Broadcast submitted ${pool.pairSymbol} | tx: ${result.txHash}`);
    } else {
      console.warn(`⚠️ Broadcast failed ${pool.pairSymbol}: ${result?.reason || "Unknown"}`);
      await sendTelegram(`⚠️ Broadcast failed ${pool.pairSymbol}: ${result?.reason || "Unknown"}`);
    }

    // 🧹 Clean up JSON after broadcast
    removePoolById(id);

  } catch (e) {
    console.error(`[PoolExecutor] Fatal error for ${pool.pairSymbol}:`, e.message);
    await sendTelegram(`❌ Fatal error executing ${pool.pairSymbol}: ${e.message}`);
    removePoolById(pool.id);
  }
}