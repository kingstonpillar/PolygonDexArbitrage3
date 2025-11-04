// decoder.js
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Fix __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Load ABIs WITHOUT assert syntax
const v2ABI = JSON.parse(fs.readFileSync(path.join(__dirname, "uniswapV2Router.json"), "utf8"));
const v3ABI = JSON.parse(fs.readFileSync(path.join(__dirname, "uniswapV3Router.json"), "utf8"));
const balancerABI = JSON.parse(fs.readFileSync(path.join(__dirname, "balancerVault.json"), "utf8"));
const curveABI = JSON.parse(fs.readFileSync(path.join(__dirname, "curvePool.json"), "utf8"));
const kyberABI = JSON.parse(fs.readFileSync(path.join(__dirname, "kyberElastic.json"), "utf8"));

// ✅ MAIN DECODE ENTRY
export function decodeSwapForRouter(tx, routerKind) {
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

/* ────────────────────────────────
   Uniswap V2 / QuickSwap / Sushi
────────────────────────────────── */
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

/* ────────────────────────────────
             Uniswap V3
────────────────────────────────── */
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

/* ────────────────────────────────
              Balancer
────────────────────────────────── */
function decodeBalancer(tx) {
  const iface = new ethers.Interface(balancerABI);

  try {
    const decoded = iface.parseTransaction({ data: tx.input });

    return {
      method: decoded.name,
      tokenIn: decoded.args.assets?.[0] || null,
      tokenOut: decoded.args.assets?.[decoded.args.assets.length - 1] || null,
      amountIn: decoded.args.limits?.[0]?.toString() ?? null,
      amountOutMin: decoded.args.limits?.[decoded.args.limits.length - 1]?.toString() ?? null,
    };
  } catch {
    return null;
  }
}

/* ────────────────────────────────
                Curve
────────────────────────────────── */
function decodeCurve(tx) {
  const iface = new ethers.Interface(curveABI);

  try {
    const decoded = iface.parseTransaction({ data: tx.input });

    return {
      method: decoded.name,
      tokenIn: decoded.args._from,
      tokenOut: decoded.args._to,
      amountIn: decoded.args._dx?.toString() ?? null,
      amountOutMin: decoded.args._min_dy?.toString() ?? null,
    };
  } catch {
    return null;
  }
}

/* ────────────────────────────────
                Kyber
────────────────────────────────── */
function decodeKyber(tx) {
  const iface = new ethers.Interface(kyberABI);

  try {
    const decoded = iface.parseTransaction({ data: tx.input });

    return {
      method: decoded.name,
      tokenIn: decoded.args.tokenIn,
      tokenOut: decoded.args.tokenOut,
      amountIn: decoded.args.amountIn?.toString() ?? null,
      amountOutMin: decoded.args.minAmountOut?.toString() ?? null,
    };
  } catch {
    return null;
  }
}