// decoder.js
import { ethers } from "ethers";

// ✅ Straight JSON import. No ABI folder.
import v2ABI from "./uniswapV2Router.json" assert { type: "json" };
import v3ABI from "./uniswapV3Router.json" assert { type: "json" };
import balancerABI from "./balancerVault.json" assert { type: "json" };
import curveABI from "./curvePool.json" assert { type: "json" };
import kyberABI from "./kyberElastic.json" assert { type: "json" };

// ✅ MAIN DECODE ENTRY
export function decodeSwapForRouter(tx, routerKind) {
  const sighash = tx.input.slice(0, 10);

  switch (routerKind) {
    case "UNISWAP_V2":
    case "SUSHISWAP":
    case "QUICKSWAP":
      return decodeV2(tx);

    case "UNISWAP_V3":
    case "ZYBERSWAP_V3":
      return decodeV3(tx);

    case "BALANCER":
      return decodeBalancer(tx);

    case "CURVE":
      return decodeCurve(tx);

    case "KYBER":
      return decodeKyber(tx);

    default:
      return null;
  }
}

/* ────────────────────────────────────────────── */
/* 🔹 Uniswap V2 / Sushi / QuickSwap Decoder      */
/* ────────────────────────────────────────────── */
function decodeV2(tx) {
  const iface = new ethers.Interface(v2ABI);

  try {
    const decoded = iface.parseTransaction({ data: tx.input });

    return {
      method: decoded.name,
      tokenIn: decoded.args.path[0],
      tokenOut: decoded.args.path[decoded.args.path.length - 1],
      amountIn: decoded.args.amountIn?.toString() ?? null,
      amountOutMin: decoded.args.amountOutMin?.toString() ?? null,
    };
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────── */
/* 🔹 Uniswap V3 Decoder                          */
/* ────────────────────────────────────────────── */
function decodeV3(tx) {
  const iface = new ethers.Interface(v3ABI);

  try {
    const decoded = iface.parseTransaction({ data: tx.input });

    if (decoded.name === "exactInputSingle") {
      return {
        method: decoded.name,
        tokenIn: decoded.args.params.tokenIn,
        tokenOut: decoded.args.params.tokenOut,
        amountIn: decoded.args.params.amountIn.toString(),
        amountOutMin: decoded.args.params.amountOutMinimum.toString(),
      };
    }

    if (decoded.name === "exactInput") {
      const path = decoded.args.path;
      const tokenIn = "0x" + path.slice(26, 66);
      const tokenOut = "0x" + path.slice(path.length - 40);

      return {
        method: decoded.name,
        tokenIn: ethers.getAddress(tokenIn),
        tokenOut: ethers.getAddress(tokenOut),
        amountIn: decoded.args.amountIn.toString(),
        amountOutMin: decoded.args.amountOutMinimum.toString(),
      };
    }
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────── */
/* 🔹 Balancer Decoder                            */
/* ────────────────────────────────────────────── */
function decodeBalancer(tx) {
  const iface = new ethers.Interface(balancerABI);

  try {
    const decoded = iface.parseTransaction({ data: tx.input });

    return {
      method: decoded.name,
      tokenIn: decoded.args.assets?.[0] || null,
      tokenOut: decoded.args.assets?.[decoded.args.assets.length - 1] || null,
      amountIn: decoded.args.limits?.[0]?.toString(),
      amountOutMin: decoded.args.limits?.[decoded.args.limits.length - 1]?.toString(),
    };
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────── */
/* 🔹 Curve Decoder                               */
/* ────────────────────────────────────────────── */
function decodeCurve(tx) {
  const iface = new ethers.Interface(curveABI);

  try {
    const decoded = iface.parseTransaction({ data: tx.input });

    return {
      method: decoded.name,
      tokenIn: decoded.args._from,
      tokenOut: decoded.args._to,
      amountIn: decoded.args._dx?.toString(),
      amountOutMin: decoded.args._min_dy?.toString(),
    };
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────── */
/* 🔹 Kyber Elastic Decoder                       */
/* ────────────────────────────────────────────── */
function decodeKyber(tx) {
  const iface = new ethers.Interface(kyberABI);

  try {
    const decoded = iface.parseTransaction({ data: tx.input });

    return {
      method: decoded.name,
      tokenIn: decoded.args.tokenIn,
      tokenOut: decoded.args.tokenOut,
      amountIn: decoded.args.amountIn?.toString(),
      amountOutMin: decoded.args.minAmountOut?.toString(),
    };
  } catch {
    return null;
  }
}