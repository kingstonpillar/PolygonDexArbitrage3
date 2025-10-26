// priceImpactEstimator.js
// ⚡ Unified price impact estimator for multi-DEX support (Polygon)
// Uses shared provider + cached Balancer reserve fetch + Promise.all concurrency

import { ethers } from "ethers";
import { getReadProvider } from "./dataprovider.js";
import {
  getCachedReserves,
  getBalancerPoolReserves,
  getCurvePoolReserves,
  getV2V3Reserves,
  getKyberPoolReserves
} from "./getcatchreserve.js";

// Minimal ERC20 ABI
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// V2 Router ABI
const V2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory amounts)"
];

// V3 Quoter ABI
const V3_QUOTER_ABI = [
  "function quoteExactInput(bytes memory path, uint256 amountIn) view returns (uint256 amountOut)"
];

// ===========================================================
// 🔹 priceImpactEstimator()
// ===========================================================
export async function priceImpactEstimator({
  dexType,
  router,
  tokenIn,
  tokenOut,
  reserves,
  pairAddress,
  amountIn,
  marketPrice
}) {
  const provider = getReadProvider();

  try {
    let amountOutExpected = 0n;

    // default simulation amount
    const amountInSim =
      amountIn && amountIn > 0n ? amountIn : ethers.parseUnits("100", reserves?.decimalsIn || 18);

    // =======================================================
    // 🧩 V2 DEXES — Uniswap / Sushi / QuickSwap
    // =======================================================
    if (dexType.includes("uniswap") || dexType.includes("sushi") || dexType.includes("quick")) {
      const contract = new ethers.Contract(router, V2_ROUTER_ABI, provider);
      const amounts = await contract.getAmountsOut(amountInSim, [tokenIn, tokenOut]);
      amountOutExpected = amounts[1];
    }

    // =======================================================
    // 🧩 V3 DEXES — Uniswap v3 / QuickSwap v3
    // =======================================================
    else if (dexType.includes("v3")) {
      const contract = new ethers.Contract(router, V3_QUOTER_ABI, provider);
      const path = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [tokenIn, 3000, tokenOut] // 0.3% fee default
      );
      amountOutExpected = await contract.quoteExactInput(path, amountInSim);
    }

    // =======================================================
    // ⚙️ BALANCER — uses cached reserves
    // =======================================================
    else if (dexType.includes("balancer")) {
      const reservesData = await getCachedReserves(
        getBalancerPoolReserves,
        `reserves_${pairAddress}`,
        provider,
        [{ pairAddress, dex: dexType }]
      );

      if (reservesData?.reserveIn && reservesData?.reserveOut) {
        const { reserveIn, reserveOut } = reservesData;
        const amountInAfterFee = (amountInSim * 997n) / 1000n;
        const numerator = amountInAfterFee * reserveOut;
        const denominator = reserveIn + amountInAfterFee;
        amountOutExpected = numerator / denominator;
      }
    }

    // =======================================================
    // 🧮 CURVE — fallback reserves math
    // =======================================================
    else if (dexType.includes("curve")) {
      const pools = await getCurvePoolReserves(provider, [{ pairAddress, dex: dexType }]);
      if (pools.length) {
        const { reserveIn, reserveOut } = pools[0];
        const amountInAfterFee = (amountInSim * 997n) / 1000n;
        const numerator = amountInAfterFee * reserveOut;
        const denominator = reserveIn + amountInAfterFee;
        amountOutExpected = numerator / denominator;
      }
    }

    // =======================================================
    // 🧮 KYBER — fallback reserves math
    // =======================================================
    else if (dexType.includes("kyber")) {
      const pools = await getKyberPoolReserves(provider, [{ pairAddress, dex: dexType }]);
      if (pools.length) {
        const { reserveIn, reserveOut } = pools[0];
        const amountInAfterFee = (amountInSim * 997n) / 1000n;
        const numerator = amountInAfterFee * reserveOut;
        const denominator = reserveIn + amountInAfterFee;
        amountOutExpected = numerator / denominator;
      }
    }

    // =======================================================
    // 🧮 V2/V3 via generic getV2V3Reserves
    // =======================================================
    else if (dexType.includes("v2") || dexType.includes("v3")) {
      const pools = await getV2V3Reserves(provider, [{ pairAddress, dex: dexType }]);
      if (pools.length) {
        const { reserveIn, reserveOut } = pools[0];
        const amountInAfterFee = (amountInSim * 997n) / 1000n;
        const numerator = amountInAfterFee * reserveOut;
        const denominator = reserveIn + amountInAfterFee;
        amountOutExpected = numerator / denominator;
      }
    }

    // =======================================================
    // 📉 Compute price impact (basis points)
    // =======================================================
    const priceImpactBps =
      amountOutExpected && marketPrice
        ? Math.abs(
            Number(
              ((BigInt(marketPrice) - BigInt(amountOutExpected)) * 10000n) /
                BigInt(marketPrice)
            )
          )
        : 0;

    return {
      dexType,
      amountInSim,
      amountOutExpected,
      priceImpactBps
    };
  } catch (err) {
    console.warn(`[ImpactEstimator] Error (${dexType}):`, err.message);
    return { dexType, amountInSim: 0n, amountOutExpected: 0n, priceImpactBps: 0 };
  }
}