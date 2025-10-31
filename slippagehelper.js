// slippagehelper.js — BigInt safe + POL/MATIC compatible
// -------------------------------------------------------
import { ethers } from "ethers";
import { getBalancerPoolReserves, getCurvePoolReserves } from "./balancercurve.js";
import { getKyberElasticReserves } from "./kyberelastic.js";
import { resolveV2V3Pairs } from "./v2v3resolver.js";
import { getReadProvider } from "./dataprovider.js";

// ✅ Universal JSON import (safe for PM2 / Node / ESM)
let routers = {};
try {
  const mod = await import("./routers.json", { assert: { type: "json" } });
  routers = mod.default;
} catch (err) {
  console.error("[SlippageHelper] Failed to load routers.json:", err);
  process.exit(1);
}
// -------------------------------------------------------


const ERC20_ABI = ["function decimals() view returns (uint8)"];
const CACHE_TTL = 200; // ms cache
const _cache = new Map();
const _decCache = new Map();

/**
 * Cache helper
 */
async function getCached(key, fetcher) {
  const now = Date.now();
  const cached = _cache.get(key);
  if (cached && now - cached.time < CACHE_TTL) return cached.value;
  const value = await fetcher();
  _cache.set(key, { value, time: now });
  return value;
}

/**
 * Normalize POL / MATIC to one logical "native"
 */
function normalizeNativeToken(addr) {
  if (!addr) return addr;
  const a = addr.toLowerCase();
  if (
    a === "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" || // WMATIC
    a === "0x4c28f48448720e9000907bc2611f73022fdce1fa"   // WPOL
  )
    return "native";
  return a;
}

/**
 * Get token decimals with fallback and cache
 */
async function getTokenDecimals(provider, token) {
  if (!token || token === "native") return 18;
  const t = token.toLowerCase();
  if (_decCache.has(t)) return _decCache.get(t);
  try {
    const contract = new ethers.Contract(t, ERC20_ABI, provider);
    const dec = await contract.decimals();
    _decCache.set(t, Number(dec));
    return Number(dec);
  } catch {
    _decCache.set(t, 18);
    return 18;
  }
}

/**
 * BigInt math helpers for DEX formulas
 */
function computeV2AmountOut(amountIn, reserveIn, reserveOut, feeBps = 30n) {
  // 30 bps = 0.3%
  const amountInWithFee = (amountIn * (10000n - feeBps)) / 10000n;
  return (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
}

function computeBalancerAmountOut(amountIn, reserveIn, reserveOut) {
  // simplified BigInt safe proportional swap
  return (amountIn * reserveOut) / (reserveIn + amountIn);
}

function computeCurveAmountOut(amountIn, reserveIn, reserveOut) {
  return (amountIn * reserveOut) / (reserveIn + amountIn);
}

function computeV3AmountOut(amountIn, sqrtPriceX96) {
  const price = Number(sqrtPriceX96) / 2 ** 96;
  return BigInt(Math.floor(Number(amountIn) * price));
}

/**
 * Compute slippage %
 */
function computeSlippage(amountIn, amountOut) {
  if (amountIn === 0n || amountOut === 0n) return 0;
  const diff = amountIn > amountOut ? amountIn - amountOut : amountOut - amountIn;
  const slip = Number(diff * 10000n / amountIn) / 100; // % with 2 decimals
  return slip;
}

/**
 * Main — getRealSlippage
 */
export async function getRealSlippage(dexName, tokenIn, tokenOut, amountInHuman = 1) {
  const key = `${dexName}-${tokenIn}-${tokenOut}`;
  return await getCached(key, async () => {
    try {
      const provider = await getReadProvider();
      const dexLower = dexName.toLowerCase();

      const inNorm = normalizeNativeToken(tokenIn);
      const outNorm = normalizeNativeToken(tokenOut);

      const decIn = await getTokenDecimals(provider, inNorm);
      const decOut = await getTokenDecimals(provider, outNorm);

      const amountIn = ethers.parseUnits(amountInHuman.toString(), decIn); // BigInt
      let amountOut = 0n;

      // --- V2 / V3 pools ---
      if (["uni", "sushi", "quick", "ape"].some(d => dexLower.includes(d))) {
        const pools = await resolveV2V3Pairs([
          { dex: dexName, pairAddress: routers[dexLower]?.address, version: "v2" }
        ]);
        if (pools.length > 0) {
          const p = pools[0];
          amountOut = computeV2AmountOut(BigInt(p.amountIn ?? amountIn), BigInt(p.reserve0), BigInt(p.reserve1));
        }
      }

      // --- Balancer ---
      else if (dexLower.includes("balancer")) {
        const reserves = await getBalancerPoolReserves([
          { dex: dexName, pairAddress: routers[dexLower]?.address }
        ]);
        if (reserves.length > 0) {
          const r = reserves[0];
          amountOut = computeBalancerAmountOut(amountIn, BigInt(r.reserve0), BigInt(r.reserve1));
        }
      }

      // --- Curve ---
      else if (dexLower.includes("curve")) {
        const reserves = await getCurvePoolReserves([
          { dex: dexName, pairAddress: routers[dexLower]?.address }
        ]);
        if (reserves.length > 0) {
          const r = reserves[0];
          amountOut = computeCurveAmountOut(amountIn, BigInt(r.reserve0), BigInt(r.reserve1));
        }
      }

      // --- Kyber Elastic ---
      else if (dexLower.includes("kyber")) {
        const reserves = await getKyberElasticReserves([
          { dex: dexName, pairAddress: routers[dexLower]?.address }
        ]);
        if (reserves.length > 0) {
          const r = reserves[0];
          amountOut = computeV3AmountOut(amountIn, BigInt(r.reserve0 / r.reserve1));
        }
      }

      if (amountOut === 0n) return 0.3;

      return computeSlippage(amountIn, amountOut);
    } catch (err) {
      console.warn(`[SlippageHelper] ${dexName} failed: ${err.message}`);
      return 0.3;
    }
  });
}