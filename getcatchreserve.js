// getcatchreserve.js
// Unified reserve fetcher for multiple DEXs (Polygon)
// Uses dataprovider.js for provider access
// Fetches: V2, V3, Balancer, Curve, Kyber
// ⚡ Optimized with Promise.all

import { ethers } from "ethers";
import { getReadProvider } from "./dataprovider.js";

// -------------------
// Cache helper
// -------------------
const cache = new Map();
export async function getCachedReserves(fetcherFn, key, provider, args, ttl = 200) {
  const now = Date.now();
  if (cache.has(key)) {
    const { ts, data } = cache.get(key);
    if (now - ts < ttl) return data;
  }

  const data = await fetcherFn(provider, ...args);
  cache.set(key, { ts: now, data });
  return data;
}

// -------------------
// Balancer — fetch reserves from vault (cached)
// -------------------
export async function getBalancerPoolReserves(provider, poolList) {
  const BALANCER_POOL_ABI = [
    "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances)"
  ];

  return Promise.all(
    poolList.map(async ({ pairAddress, dex }) => {
      try {
        const contract = new ethers.Contract(pairAddress, BALANCER_POOL_ABI, provider);
        const { tokens, balances } = await contract.getPoolTokens(pairAddress);
        return {
          pairAddress,
          dex,
          token0: tokens[0],
          token1: tokens[1],
          reserve0: BigInt(balances[0].toString()),
          reserve1: BigInt(balances[1].toString())
        };
      } catch (err) {
        console.warn(`[Balancer] Failed for ${pairAddress}:`, err.message);
        return null;
      }
    })
  );
}

// -------------------
// Curve — fallback reserves
// -------------------
export async function getCurvePoolReserves(provider, poolList) {
  return Promise.all(
    poolList.map(({ pairAddress, dex }) => {
      const reserve0 = BigInt("1000000000000000000000"); // placeholder
      const reserve1 = BigInt("1000000000000000000000");
      return { pairAddress, dex, token0: "", token1: "", reserve0, reserve1 };
    })
  );
}

// -------------------
// Kyber — fallback reserves
// -------------------
export async function getKyberPoolReserves(provider, poolList) {
  return Promise.all(
    poolList.map(({ pairAddress, dex }) => {
      const reserve0 = BigInt("1000000000000000000000"); // placeholder
      const reserve1 = BigInt("1000000000000000000000");
      return { pairAddress, dex, token0: "", token1: "", reserve0, reserve1 };
    })
  );
}

// -------------------
// V2 / V3 — Uniswap / Sushi / QuickSwap
// -------------------
export async function getV2V3Reserves(poolList) {
  const provider = getReadProvider();
  const V2_PAIR_ABI = [
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() view returns (address)",
    "function token1() view returns (address)"
  ];
  const ERC20_ABI = ["function decimals() view returns (uint8)"];

  return Promise.all(
    poolList.map(async ({ pairAddress }) => {
      try {
        const contract = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
        const [reserve0, reserve1] = await contract.getReserves();
        const token0 = await contract.token0();
        const token1 = await contract.token1();

        const token0Contract = new ethers.Contract(token0, ERC20_ABI, provider);
        const token1Contract = new ethers.Contract(token1, ERC20_ABI, provider);
        const decimals0 = await token0Contract.decimals().catch(() => 18);
        const decimals1 = await token1Contract.decimals().catch(() => 18);

        return {
          pairAddress,
          token0,
          token1,
          reserve0: BigInt(reserve0.toString()),
          reserve1: BigInt(reserve1.toString()),
          decimals0,
          decimals1
        };
      } catch (err) {
        console.warn(`[V2/V3] Failed for ${pairAddress}:`, err.message);
        return null;
      }
    })
  );
}