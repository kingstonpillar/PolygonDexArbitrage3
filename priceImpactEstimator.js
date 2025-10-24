// priceImpactEstimator.js
// Ethers v6 + factory-less DEX support (Balancer, Curve, Kyber, V2/V3)
// Integrated with dataprovider.js for unified provider access

import { ethers } from "ethers";
import { Interface } from "ethers";
import { getReadProvider } from "./dataprovider.js"; // ✅ integrated provider

// ERC20 ABI minimal
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// Universal DEX ABIs (simplified)
const V2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)"
];
const V3_QUOTER_ABI = [
  "function quoteExactInput(bytes memory path, uint256 amountIn) view returns (uint256 amountOut)"
];

// estimator core
export async function estimatePriceImpact({
  dexType,
  router,
  tx,
  tokenIn,
  tokenOut,
  reserves,
  amountIn
}) {
  const provider = getReadProvider(); // ✅ uses shared provider
  try {
    let iface, amountOutExpected;

    // Use 0.1% of liquidity or tx value as simulated amount
    const amountInSim = amountIn || ethers.parseUnits("100", reserves.decimalsIn || 18);

    if (dexType.includes("v2")) {
      iface = new Interface(V2_ROUTER_ABI);
      const contract = new ethers.Contract(router, V2_ROUTER_ABI, provider);
      const amounts = await contract.getAmountsOut(amountInSim, [tokenIn, tokenOut]);
      amountOutExpected = amounts[1];
    }

    else if (dexType.includes("v3")) {
      iface = new Interface(V3_QUOTER_ABI);
      const contract = new ethers.Contract(router, V3_QUOTER_ABI, provider);
      const path = ethers.solidityPacked(["address", "uint24", "address"], [tokenIn, 3000, tokenOut]);
      amountOutExpected = await contract.quoteExactInput(path, amountInSim);
    }

    else if (dexType.includes("balancer") || dexType.includes("curve") || dexType.includes("kyber")) {
      // FACTORY-LESS fallback — uses reserves math (approximation)
      const { reserveIn, reserveOut } = reserves;
      const amountInAfterFee = amountInSim * 997n / 1000n;
      const numerator = amountInAfterFee * reserveOut;
      const denominator = reserveIn + amountInAfterFee;
      amountOutExpected = numerator / denominator;
    }

    // === Compute price impact ===
    const priceBefore = Number(reserves.reserveOut) / Number(reserves.reserveIn);
    const priceAfter = Number(reserves.reserveOut - amountOutExpected) / Number(reserves.reserveIn + amountInSim);
    const impactPct = ((priceBefore - priceAfter) / priceBefore) * 100;

    return {
      success: true,
      dexType,
      router,
      tokenIn,
      tokenOut,
      amountIn: amountInSim.toString(),
      amountOut: amountOutExpected.toString(),
      priceImpactPct: impactPct,
    };

  } catch (err) {
    console.error(`[ImpactEstimator] Error: ${err.message}`);
    return { success: false, error: err.message };
  }
}