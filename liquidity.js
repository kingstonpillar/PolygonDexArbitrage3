// liquidity.js
import { ethers } from "ethers";
import { getTokenUsdPrice } from "./uniswapOracle.js";

/**
 * Simple in-memory price cache to avoid hammering price source.
 * keys are token address (lowercase) or symbol (uppercase).
 */
const _priceCache = {};
const _priceFetchedAt = {}; // ms timestamp

const PRICE_CACHE_TTL = 60_000; // 60s

// Helper: normalize input (BigInt | number | numeric string) -> float
function bnToFloat(amount, decimals = 18) {
  try {
    // ethers.formatUnits handles BigInt, number-as-string, or bigint-like strings
    if (typeof amount === "bigint" || typeof amount === "string" || typeof amount === "number") {
      // formatUnits expects BigInt|string|Number; ensure we pass string for very large numbers
      return parseFloat(ethers.formatUnits(amount, decimals));
    }
    // fallback (if amount already numeric)
    return parseFloat(amount);
  } catch (err) {
    // If formatting fails, return 0 (safer than throwing here)
    return 0;
  }
}

// Try to get price from cache or fetch via uniswapOracle.getTokenUsdPrice
async function fetchTokenUsdPrice(tokenOrSymbol) {
  if (!tokenOrSymbol) return 0;

  const key = String(tokenOrSymbol).toLowerCase();
  const now = Date.now();

  if (_priceCache[key] && (now - (_priceFetchedAt[key] || 0) < PRICE_CACHE_TTL)) {
    return _priceCache[key];
  }

  let price = 0;

  // Prefer address-based query if input looks like an address
  try {
    if (typeof tokenOrSymbol === "string" && tokenOrSymbol.startsWith("0x")) {
      // Some implementations of getTokenUsdPrice expect symbol rather than address.
      // We try address first; if it returns falsy, try symbol fallback.
      price = await getTokenUsdPrice(tokenOrSymbol);
      if (!price) {
        // try passing symbol derived from address as a safety fallback (unlikely but defensive)
        // no-op here — higher-level callers can provide "WMATIC" / "POL" when needed
      }
    } else {
      // tokenOrSymbol probably a symbol (e.g., "WMATIC")
      price = await getTokenUsdPrice(tokenOrSymbol);
    }
  } catch (err) {
    price = 0;
  }

  // Cache it (use lowercase key)
  _priceCache[key] = price || 0;
  _priceFetchedAt[key] = now;
  return _priceCache[key];
}

/**
 * calcLiquidityUSD
 * Convert a reserve amount of `tokenAddress` into USD.
 *
 * reserveAmount: BigInt | string | number
 * tokenAddress: token address (0x...) OR symbol like "WMATIC" (string). address preferred.
 * priceMap: optional map { [tokenAddressLower]: priceUSD } used as quick override
 * decimals: optional — if not provided we assume 18 except for common stable tokens (6)
 */
export async function calcLiquidityUSD(reserveAmount, tokenAddress, priceMap = {}, decimals = undefined) {
  if (!reserveAmount) return 0;

  // Normalize tokenAddress to lowercase if it's an address
  const addr = typeof tokenAddress === "string" ? tokenAddress.toLowerCase() : tokenAddress;

  // Known stable tokens (addresses lowercased). If your env customises these, you can extend.
  const STABLES = [
    (process.env.HUB_TOKEN_1 || "0x2791Bca1f2de4661ED88A30C99A7a944aA84174").toLowerCase(), // USDC
    (process.env.HUB_TOKEN_2 || "0xc2132D05D31c914a87C6611C10748AaCB4FE7392").toLowerCase(), // USDT
    (process.env.HUB_TOKEN_3 || "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063").toLowerCase()  // DAI
  ];

  // WMATIC / POL addresses (from env or default)
  const WMATIC_ADDR = (process.env.HUB_TOKEN_4 || "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270").toLowerCase();
  const POL_ADDR = (process.env.HUB_TOKEN_5 || "0x0000000000000000000000000000000000001010").toLowerCase();

  // If decimals explicitly provided use it, else:
  // - 6 decimals for stables
  // - 18 decimals otherwise (default)
  let tokenDecimals = 18;
  if (typeof decimals === "number") tokenDecimals = decimals;
  else if (STABLES.includes(addr)) tokenDecimals = 6;

  // If priceMap has a value keyed by token address, use it immediately
  if (addr && priceMap && priceMap[addr]) {
    const price = priceMap[addr];
    const qty = bnToFloat(reserveAmount, tokenDecimals);
    return qty * (Number(price) || 0);
  }

  // If token is stablecoin -> USD (1:1)
  if (addr && STABLES.includes(addr)) {
    return bnToFloat(reserveAmount, tokenDecimals); // already in USD units (USDC/USDT 6 decimals)
  }

  // If token is WMATIC or POL -> fetch MATIC price and multiply
  if (addr === WMATIC_ADDR || addr === POL_ADDR) {
    // we prefer symbol queries for readability
    const symbol = addr === WMATIC_ADDR ? "WMATIC" : "POL";
    const price = await fetchTokenUsdPrice(symbol);
    return bnToFloat(reserveAmount, tokenDecimals) * (price || 0);
  }

  // If tokenAddress looks like a symbol (not an address), try symbol lookup first
  if (typeof tokenAddress === "string" && !tokenAddress.toLowerCase().startsWith("0x")) {
    const priceBySymbol = await fetchTokenUsdPrice(tokenAddress);
    if (priceBySymbol) return bnToFloat(reserveAmount, tokenDecimals) * priceBySymbol;
  }

  // Try address-based price lookup
  const priceByAddress = await fetchTokenUsdPrice(addr);
  if (priceByAddress) return bnToFloat(reserveAmount, tokenDecimals) * priceByAddress;

  // Last fallback: use WMATIC as denom (assume token correlated to MATIC)
  const fallback = await fetchTokenUsdPrice("WMATIC");
  return bnToFloat(reserveAmount, tokenDecimals) * (fallback || 0);
}

/**
 * pairLiquidityUSD
 * Accepts a pair-like object:
 * {
 *   reserve0, reserve1, token0, token1, decimals0?, decimals1?
 * }
 * Returns USD value of both reserves combined.
 *
 * If caller doesn't pass decimals, the function will apply defaults (6 for common stable tokens, 18 otherwise).
 */
export async function pairLiquidityUSD(pair, priceMap = {}) {
  if (!pair) return 0;

  const {
    reserve0,
    reserve1,
    token0,
    token1,
    decimals0 = undefined,
    decimals1 = undefined
  } = pair;

  // calculate usd for each side
  const usd0 = await calcLiquidityUSD(reserve0, token0, priceMap, decimals0);
  const usd1 = await calcLiquidityUSD(reserve1, token1, priceMap, decimals1);

  const total = (Number(usd0) || 0) + (Number(usd1) || 0);
  return total;
}

// default export for compatibility if some modules expect default
export default { calcLiquidityUSD, pairLiquidityUSD };