// decoder.js
import { Interface } from "ethers";

// === ABIs (trimmed to swap functions only) ===
const ABI_V2 = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)",
  "function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)",
];

const ABI_V3 = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))",
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96))",
  "function exactInput(bytes path,uint256 amountIn,uint256 amountOutMinimum,address recipient,uint256 deadline)",
  "function exactOutput(bytes path,uint256 amountOut,uint256 amountInMaximum,address recipient,uint256 deadline)",
];

const ABI_BALANCER = [
  "function swap((bytes32 poolId,uint8 kind,address assetIn,address assetOut,uint256 amount,bool userData),uint256 limit,uint256 deadline)"
];

const ABI_KYBER = [
  "function swapExactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum))",
  "function swapExactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum))",
];

const ABI_CURVE = [
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy)",
];

// === Create interfaces ===
const ifaceV2 = new Interface(ABI_V2);
const ifaceV3 = new Interface(ABI_V3);
const ifaceBalancer = new Interface(ABI_BALANCER);
const ifaceKyber = new Interface(ABI_KYBER);
const ifaceCurve = new Interface(ABI_CURVE);

// === Map router kinds to interfaces ===
const interfaceMap = {
  V2: ifaceV2,
  V3: ifaceV3,
  BALANCER: ifaceBalancer,
  CURVE: ifaceCurve,
  KYBER: ifaceKyber,
};

// === Helper: tryDecode ===
function tryDecode(tx, iface) {
  try {
    return iface.parseTransaction({ data: tx.input });
  } catch {
    return null;
  }
}

// === Main decode function ===
export function decodeSwapForRouter(tx, kind = "V2") {
  const iface = interfaceMap[kind] || ifaceV2;
  const decoded = tryDecode(tx, iface);
  if (!decoded) return null;

  const method = decoded.name;
  const args = decoded.args || {};

  let tokenIn, tokenOut, amountIn, amountOutMin;

  switch (kind) {
    case "V2":
      if (decoded.name.includes("swapExact")) {
        amountIn = args.amountIn?.toString() || "0";
        amountOutMin = args.amountOutMin?.toString() || "0";
        tokenIn = args.path?.[0];
        tokenOut = args.path?.slice(-1)[0];
      }
      break;

    case "V3":
    case "KYBER":
      if (args.params) {
        const p = args.params;
        tokenIn = p.tokenIn;
        tokenOut = p.tokenOut;
        amountIn = p.amountIn?.toString();
        amountOutMin = p.amountOutMinimum?.toString();
      } else if (decoded.name === "exactInput" || decoded.name === "exactOutput") {
        tokenIn = "path"; // encoded path, decode optional
        tokenOut = "path";
      }
      break;

    case "BALANCER":
      if (args.singleSwap) {
        const s = args.singleSwap;
        tokenIn = s.assetIn;
        tokenOut = s.assetOut;
        amountIn = s.amount?.toString();
      }
      break;

    case "CURVE":
      tokenIn = args[0];
      tokenOut = args[1];
      amountIn = args[2]?.toString();
      amountOutMin = args[3]?.toString();
      break;

    default:
      break;
  }

  return {
    dexKind: kind,
    method,
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMin,
    priceEst:
      amountIn && amountOutMin
        ? Number(amountOutMin) / Number(amountIn)
        : 0,
  };
}