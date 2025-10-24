// balancercurve.js — BigInt-safe reserves for Balancer & Curve
import { ethers } from "ethers";
import { getReadProvider } from "./dataprovider.js";

// Helper: promise with timeout
async function promiseWithTimeout(promise, ms = 3000, fallback = null) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms))),
  ]).finally(() => clearTimeout(timer));
}

// Simple in-memory cache
const cache = new Map();
function setCache(key, value, ttl = 200) {
  cache.set(key, { value, expire: Date.now() + ttl });
}
function getCache(key) {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expire) return entry.value;
  cache.delete(key);
  return null;
}

// =============================================================
// BALANCER VAULT reserves (tokens + balances, BigInt-safe)
// =============================================================
export async function getBalancerPoolReserves(pools) {
  const provider = await getReadProvider();
  const VAULT_ABI = [
    "function getPoolTokens(bytes32 poolId) view returns (address[], uint256[], uint256)"
  ];

  const vault = new ethers.Contract(
    "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    VAULT_ABI,
    provider
  );

  const results = await Promise.all(
    pools.map(async (p) => {
      const cacheKey = `bal:${p.poolId || p.pairAddress}`;
      const cached = getCache(cacheKey);
      if (cached) return cached;

      try {
        const [tokens, balances] = await promiseWithTimeout(
          vault.getPoolTokens(p.poolId || p.pairAddress),
          3000,
          [[], [0n, 0n]]
        );

        const token0 = tokens?.[0] || ethers.ZeroAddress;
        const token1 = tokens?.[1] || ethers.ZeroAddress;
        const reserve0 = BigInt(balances?.[0] || 0n);
        const reserve1 = BigInt(balances?.[1] || 0n);

        const resObj = {
          dex: p.dex,
          pairAddress: p.pairAddress,
          token0,
          token1,
          reserve0,
          reserve1,
          priceRatio: reserve0 > 0n ? Number(reserve1) / Number(reserve0) : 0,
        };

        setCache(cacheKey, resObj);
        return resObj;
      } catch (err) {
        const resObj = {
          dex: p.dex,
          pairAddress: p.pairAddress,
          token0: ethers.ZeroAddress,
          token1: ethers.ZeroAddress,
          reserve0: 0n,
          reserve1: 0n,
          priceRatio: 0,
        };
        setCache(cacheKey, resObj);
        return resObj;
      }
    })
  );

  return results;
}

// =============================================================
// CURVE reserves (tokens + balances, BigInt-safe)
// =============================================================
export async function getCurvePoolReserves(pools) {
  const provider = await getReadProvider();
  const ABI = [
    "function get_balances() view returns (uint256[2])",
    "function coins(uint256) view returns (address)"
  ];

  const results = await Promise.all(
    pools.map(async (p) => {
      const cacheKey = `curve:${p.pairAddress}`;
      const cached = getCache(cacheKey);
      if (cached) return cached;

      try {
        const contract = new ethers.Contract(p.pairAddress, ABI, provider);
        const [reserves, token0, token1] = await Promise.all([
          promiseWithTimeout(contract.get_balances(), 3000, [0n, 0n]),
          promiseWithTimeout(contract.coins(0), 3000, ethers.ZeroAddress),
          promiseWithTimeout(contract.coins(1), 3000, ethers.ZeroAddress),
        ]);

        const reserve0 = BigInt(reserves?.[0] || 0n);
        const reserve1 = BigInt(reserves?.[1] || 0n);

        const resObj = {
          dex: p.dex,
          pairAddress: p.pairAddress,
          token0,
          token1,
          reserve0,
          reserve1,
          priceRatio: reserve0 > 0n ? Number(reserve1) / Number(reserve0) : 0,
        };

        setCache(cacheKey, resObj);
        return resObj;
      } catch (err) {
        const resObj = {
          dex: p.dex,
          pairAddress: p.pairAddress,
          token0: ethers.ZeroAddress,
          token1: ethers.ZeroAddress,
          reserve0: 0n,
          reserve1: 0n,
          priceRatio: 0,
        };
        setCache(cacheKey, resObj);
        return resObj;
      }
    })
  );

  return results;
}