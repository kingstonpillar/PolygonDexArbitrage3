// protectionutilities.js
// Comprehensive risk & protection utilities for arbitrage execution

import "dotenv/config";
import { ethers } from "ethers";
import { getReadProvider } from './dataprovider.js';

// ---------- ENV CONFIG ----------
const PROFIT_THRESHOLD_BPS = Number(process.env.PROFIT_THRESHOLD_BPS || 100); // 1% default
const PROFIT_THRESHOLD_USD = Number(process.env.PROFIT_THRESHOLD_USD || 0);
const MEV_LOOKBACK_MS = Number(process.env.MEV_LOOKBACK_MS || 10000);
const CHAINLINK_STALE_SECONDS = Number(process.env.CHAINLINK_STALE_SECONDS || 180);

// ---------- HARD-CODED FALLBACK TOKENS ----------
const FALLBACK_TOKENS = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
  "0x55d398326f99059fF775485246999027B3197955", // USDT
  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", // DAI
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"  // WETH
];

// ---------- ABIs ----------
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)"
];
const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];
const V3_POOL_ABI = [
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];
const AGG_V3_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)"
];

// ---------- HELPER FUNCTIONS ----------
function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms))
  ]);
}

async function safeRead(provider, fn) {
  try {
    return await fn(provider);
  } catch {
    return null;
  }
}

// ---------- PROFIT THRESHOLD ----------
export function meetsProfitThresholdUSD(profitUsd, notionalUsd) {
  const profit = Number(profitUsd ?? 0);
  const notional = Number(notionalUsd ?? 0);
  const passUsd = profit >= PROFIT_THRESHOLD_USD;
  const profitBps = notional > 0 ? Math.floor((profit / notional) * 10000) : 0;
  const passBps = profitBps >= PROFIT_THRESHOLD_BPS;
  return { ok: passUsd && passBps, profitUsd: profit, notionalUsd: notional, profitBps };
}

export const meetsProfitThresholdUSD_Chainlink = async (provider, { profitToken, profitAmountWei, notionalToken, notionalAmountWei, feedMap }) => {
  try {
    async function fetchPrice(token) {
      const feedAddr = feedMap?.[token];
      if (!feedAddr) return null;
      return await readCallWithProvider(`chainlink.latest:${feedAddr}`, provider, async (p) => {
        const c = new ethers.Contract(feedAddr, AGG_V3_ABI, p);
        const dec = Number(await c.decimals());
        const rd = await c.latestRoundData();
        const updatedAt = Number(rd.updatedAt ?? 0n);
        const nowS = Math.floor(Date.now() / 1000);
        if (nowS - updatedAt > CHAINLINK_STALE_SECONDS) return null;
        return Number(ethers.formatUnits(rd.answer ?? 0n, dec));
      });
    }

    async function fetchDecimals(token) {
      if (!token || token === ethers.ZeroAddress) return 18;
      return await readCallWithProvider(`erc20.decimals:${token}`, provider, async (p) => {
        const c = new ethers.Contract(token, ERC20_ABI, p);
        return Number(await c.decimals()) ?? 18;
      }).catch(() => 18);
    }

    const [profitPrice, notionalPrice, profitDec, notionalDec] = await Promise.all([
      fetchPrice(profitToken),
      fetchPrice(notionalToken),
      fetchDecimals(profitToken),
      fetchDecimals(notionalToken)
    ]);

    if (!profitPrice || !notionalPrice) return { ok: false, reason: "missingOrStaleFeed" };

    const profitUsd = Number(ethers.formatUnits(profitAmountWei ?? 0n, profitDec)) * profitPrice;
    const notionalUsd = Number(ethers.formatUnits(notionalAmountWei ?? 0n, notionalDec)) * notionalPrice;

    return meetsProfitThresholdUSD(profitUsd, notionalUsd);
  } catch {
    return { ok: false, reason: "chainlinkError" };
  }
};

// ---------- FLASHLOAN AVAILABILITY ----------
export const isFlashLoanAvailable = async (candidates = []) => {
  const AAVE_LOAN = (process.env.AAVE_LOAN ?? "false").toLowerCase() === "true";
  const BAL_LOAN = (process.env.BAL_LOAN ?? "false").toLowerCase() === "true";

  if (!AAVE_LOAN && !BAL_LOAN) return { ok: false, reason: "loansDisabledInEnv" };

  async function checkBalance(token, addr, needed) {
    return await readCall(`erc20.balanceOf:${token}`, async (p) => {
      const bal = await new ethers.Contract(token, ERC20_ABI, p).balanceOf(addr);
      return bal >= BigInt(needed);
    });
  }

  let aaveOk = false, balOk = false;
  if (AAVE_LOAN) {
    for (const c of candidates.filter(c => c.type === "aave")) {
      if (await checkBalance(c.token, c.addr, c.needed)) { aaveOk = true; break; }
    }
  }
  if (BAL_LOAN) {
    for (const c of candidates.filter(c => c.type === "balancer")) {
      if (await checkBalance(c.token, c.addr, c.needed)) { balOk = true; break; }
    }
  }

  return { ok: aaveOk || balOk, aave: aaveOk, balancer: balOk, reason: aaveOk || balOk ? null : "noLiquidity" };
};

// ---------- FALLBACK TOKEN ----------
export const chooseFallbackToken = async (loanAsset) => {
  // Pick token from hardcoded list matching loan asset
  const token = FALLBACK_TOKENS.find(t => t.toLowerCase() === loanAsset.toLowerCase());
  if (!token) return { ok: false };
  return { ok: true, token };
};

// ---------- PROFIT LOCK ----------
export const lockProfit = (profitUsd, lockPct = 0.75) => {
  if (!Number.isFinite(profitUsd) || profitUsd <= 0) return { locked: 0, leftover: 0 };
  const cents = Math.round(profitUsd * 100);
  const locked = Math.round(cents * lockPct);
  return { locked: locked / 100, leftover: (cents - locked) / 100 };
};

// ---------- V2 / V3 RESERVES ----------
export const getV2Reserves = async (pair) => {
  const provider = await getReadProvider();
  return await readCallWithProvider(`v2.getReserves:${pair}`, provider, async (p) => {
    const c = new ethers.Contract(pair, V2_PAIR_ABI, p);
    const [t0, t1, reserves] = await Promise.all([c.token0(), c.token1(), c.getReserves()]);
    return { token0: t0, token1: t1, r0: BigInt(reserves.reserve0 ?? reserves[0] ?? 0), r1: BigInt(reserves.reserve1 ?? reserves[1] ?? 0) };
  }).catch(() => null);
};

export const getV3State = async (pool) => {
  const provider = await getReadProvider();
  return await readCallWithProvider(`v3.slot0:${pool}`, provider, async (p) => {
    const c = new ethers.Contract(pool, V3_POOL_ABI, p);
    const [slot0, liquidity, t0, t1] = await Promise.all([c.slot0(), c.liquidity(), c.token0(), c.token1()]);
    return { token0: t0, token1: t1, sqrtPriceX96: slot0.sqrtPriceX96 ?? slot0[0], liquidity: BigInt(liquidity) };
  }).catch(() => null);
};

// ---------- DYNAMIC RESERVE TRADE CHECK ----------
export const reserveTradeCheck = async ({ poolType, poolAddress, tokenIn, desiredAmount }) => {
  const provider = await getReadProvider();
  let safeAmount = 0n;
  let info = null;

  if (poolType === "V2") {
    const res = await getV2Reserves(poolAddress);
    if (!res) return { safeAmount, info };
    const reserveIn = res.token0.toLowerCase() === tokenIn.toLowerCase() ? res.r0 : res.r1;
    safeAmount = BigInt(desiredAmount) <= reserveIn ? BigInt(desiredAmount) : 0n;
    info = res;
  } else if (poolType === "V3") {
    const res = await getV3State(poolAddress);
    if (!res) return { safeAmount, info };
    safeAmount = BigInt(desiredAmount) <= res.liquidity ? BigInt(desiredAmount) : 0n;
    info = res;
  }

  return { safeAmount, info };
};

// ---------- READ CALL HELPERS ----------
export async function readCall(label, fn, timeoutMs = 5000) {
  const provider = await getReadProvider();
  return await withTimeout(safeRead(provider, fn), timeoutMs, label);
}

export async function readCallWithProvider(label, provider, fn, timeoutMs = 5000) {
  return await withTimeout(safeRead(provider, fn), timeoutMs, label);
}

// ---------- COMPOSED GUARD ----------
export const runProtections = async (params) => {
  const {
    expectedOut,
    minOut,
    txRequest,
    profitUsd,
    notionalUsd,
    profitToken,
    profitAmountWei,
    notionalToken,
    notionalAmountWei,
    v2PairAddr,
    v3PoolAddr,
    loanAsset
  } = params;

  const pt = (profitUsd && notionalUsd) ? meetsProfitThresholdUSD(profitUsd, notionalUsd)
    : await meetsProfitThresholdUSD_Chainlink(await getReadProvider(), { profitToken, profitAmountWei, notionalToken, notionalAmountWei, feedMap: {} });

  if (!pt.ok) return { ok: false, reason: "profitBelowThreshold", details: pt };

  const reserves = v2PairAddr
    ? await getV2Reserves(v2PairAddr)
    : v3PoolAddr
    ? await getV3State(v3PoolAddr)
    : null;

  if (!reserves) return { ok: false, reason: "noPoolReserves" };

  const fallback = await chooseFallbackToken(loanAsset);

  const lock = lockProfit(pt.profitUsd ?? profitUsd ?? 0, 0.75);

  return { ok: true, details: { pt, reserves, fallback, lock } };
};

// ---------- DEFAULT EXPORT ----------
export default {
  meetsProfitThresholdUSD,
  meetsProfitThresholdUSD_Chainlink,
  isFlashLoanAvailable,
  chooseFallbackToken,
  lockProfit,
  getV2Reserves,
  getV3State,
  reserveTradeCheck,
  runProtections,
  readCall,
  readCallWithProvider
};