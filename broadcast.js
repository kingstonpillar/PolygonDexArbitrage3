import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { ethers, Wallet } from "ethers";

import { getProvider, getNextNonce, sendWithRetry } from "./privateRPC.js";
import { emitTradeAlert } from "./telegramalert.js";

dotenv.config();

// ================================================
// --- CONFIG ---
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);
const AAVE_CONTRACT = process.env.AAVE_FLASH_EXECUTOR;
const BALANCER_CONTRACT = process.env.BALANCER_FLASH_EXECUTOR;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_WS_URL = process.env.RPC_WS_URL || "";
const GAS_TOKEN = (process.env.GAS_TOKEN || "MATIC").toUpperCase();

const PRIVATE_RPC_MODE = (process.env.PRIVATE_RPC_MODE || "false").toLowerCase() === "true";
const DEFAULT_GAS_LIMIT = BigInt(Number(process.env.DEFAULT_GAS_LIMIT || 2_000_000));

if (!AAVE_CONTRACT || !BALANCER_CONTRACT)
  throw new Error("❌ Missing flash executor addresses");
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE_KEY in .env");

// ================================================
// --- LOAD ABIs ---
function loadJson(relPath) {
  const full = path.join(process.cwd(), relPath);
  if (!fs.existsSync(full)) throw new Error(`Missing ${relPath}`);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}
const aaveABI = loadJson("./aaveABI.json");
const balancerABI = loadJson("./balancerABI.json");

// ================================================
// --- PROVIDERS ---
let wsProvider = null;
if (RPC_WS_URL) {
  try {
    wsProvider = new ethers.WebSocketProvider(RPC_WS_URL);
    wsProvider.on("error", (err) =>
      console.warn("[broadcast] WS error:", err.message)
    );
  } catch (e) {
    console.warn("[broadcast] Failed to init WS:", e.message);
  }
}

const privateProvider = await getProvider();
const signer = new Wallet(PRIVATE_KEY, privateProvider);
const provider = wsProvider || privateProvider;

// ================================================
// --- HELPERS ---
function normalizeToWei(value, decimals = 18) {
  try {
    return ethers.parseUnits(value?.toString() || "0", decimals);
  } catch {
    return 0n;
  }
}

async function getGasTokenPrice() {
  try {
    const url =
      GAS_TOKEN === "POL"
        ? "https://api.coingecko.com/api/v3/simple/price?ids=polygon-ecosystem-token&vs_currencies=usd"
        : "https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=usd";
    const res = await fetch(url);
    const data = await res.json();
    return (
      data?.["polygon-ecosystem-token"]?.usd ||
      data?.["matic-network"]?.usd ||
      0.5
    );
  } catch (e) {
    console.warn("[broadcast] Gas price fallback:", e.message);
    return 0.5;
  }
}

async function safeDryRun(txReq) {
  if (PRIVATE_RPC_MODE) {
    console.warn("[dry-run] PRIVATE_RPC_MODE enabled: skipping dry-run");
    return { success: false, skipped: true, reason: "private_rpc_mode" };
  }
  try {
    const res = await provider.call(txReq);
    const ok = res && res !== "0x";
    return { success: ok, result: res };
  } catch (err) {
    return { success: false, error: err };
  }
}

async function getDynamicGas(txReq, boostPercent = 100) {
  try {
    let gasLimit;
    try {
      gasLimit = await provider.estimateGas(txReq);
    } catch {
      gasLimit = DEFAULT_GAS_LIMIT;
    }

    const feeData = await provider.getFeeData();
    const boostN = BigInt(Math.floor(boostPercent));

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      const boostedMaxFee =
        (BigInt(feeData.maxFeePerGas) * (100n + boostN)) / 100n;
      const boostedPriority =
        (BigInt(feeData.maxPriorityFeePerGas) * (100n + boostN)) / 100n;
      return { gasLimit, maxFeePerGas: boostedMaxFee, maxPriorityFeePerGas: boostedPriority };
    }

    if (feeData.gasPrice) {
      const boostedGasPrice = (BigInt(feeData.gasPrice) * (100n + boostN)) / 100n;
      return { gasLimit, gasPrice: boostedGasPrice };
    }

    return {
      gasLimit,
      gasPrice: ethers.parseUnits("100", "gwei"),
    };
  } catch (e) {
    console.warn("[broadcast] getDynamicGas failed:", e.message);
    return null;
  }
}

function computeGasCostUsd(gasLimit, feeObj, gasTokenUsd) {
  try {
    const perGas = feeObj.maxFeePerGas ?? feeObj.gasPrice ?? feeObj.maxPriorityFeePerGas;
    const totalWei = BigInt(gasLimit) * BigInt(perGas);
    const costNative = Number(ethers.formatEther(totalWei));
    return costNative * gasTokenUsd;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ================================================
// --- BROADCAST SINGLE POOL ---
export async function broadcastPendingPool(pool) {
  if (!pool || (!pool.tokenIn && !pool.loanAsset))
    return { status: "skip", reason: "invalid_pool" };

  const estProfit = Number(pool.profitUSD || pool.estProfitUSD || 0);
  let txAave = null, txBal = null;

  try {
    const tokenIn = pool.tokenIn || pool.loanAsset;
    const tokenOut = pool.tokenOut || pool.sellAsset || pool.targetToken;
    const gasTokenUsd = await getGasTokenPrice();

    const aaveIface = new ethers.Interface(aaveABI);
    const balIface = new ethers.Interface(balancerABI);

    const SwapKind = { V2: 0, V3: 1, BALANCER: 2, CURVE: 3, KYBER: 4 };
    const detectKind = (routerAddr) => {
      const addr = (routerAddr || "").toLowerCase();
      if (addr.includes("sushi") || addr.includes("ape") || addr.includes("quick")) return SwapKind.V2;
      if (addr.includes("uniswap") && addr.includes("v3")) return SwapKind.V3;
      if (addr.includes("balancer")) return SwapKind.BALANCER;
      if (addr.includes("curve")) return SwapKind.CURVE;
      if (addr.includes("kyber")) return SwapKind.KYBER;
      return SwapKind.V2;
    };

    // ========== AAVE EXECUTOR ==========
    try {
      const buyKind = pool.buyKind ?? detectKind(pool.buyRouter);
      const sellKind = pool.sellKind ?? detectKind(pool.sellRouter);
      const kind = sellKind ?? buyKind ?? SwapKind.V2;

      const txData = aaveIface.encodeFunctionData("executeArbitrage", [
        {
          loanAssets: [pool.loanAsset],
          loanAmounts: [normalizeToWei(pool.loanAmount)],
          steps: [
            {
              kind: buyKind,
              router: pool.buyRouter,
              path: [tokenIn, tokenOut],
              v3Fee: pool.v3Fee || 0,
              v3ExactInputSingle: pool.type === "v3",
              v3Path: pool.v3Path || "0x",
              amountIn: normalizeToWei(pool.loanAmount),
              minAmountOut: BigInt(pool.minOut ?? 0),
              deadline: 0,
              unwrap: false,
            },
            {
              kind: sellKind,
              router: pool.sellRouter,
              path: [tokenOut, tokenIn],
              v3Fee: pool.v3Fee || 0,
              v3ExactInputSingle: pool.type === "v3",
              v3Path: pool.v3Path || "0x",
              amountIn: BigInt(pool.minOut ?? 0),
              minAmountOut: BigInt(pool.minIn ?? 0),
              deadline: 0,
              unwrap: false,
            },
          ],
        },
      ]);

      const dry = await safeDryRun({ to: AAVE_CONTRACT, data: txData });
      if (dry.success === false && !dry.skipped)
        await emitTradeAlert("skip", pool, "Aave dry-run failed", { venue: "Aave" });

      const gasObj = await getDynamicGas({ to: AAVE_CONTRACT, data: txData }, 150);
      if (gasObj) {
        const txReq = { to: AAVE_CONTRACT, data: txData, chainId: CHAIN_ID, nonce: await getNextNonce(), ...gasObj };
        const gasCostUsd = computeGasCostUsd(txReq.gasLimit, gasObj, gasTokenUsd);
        if (gasCostUsd <= estProfit) {
          txAave = await sendWithRetry(() => signer.sendTransaction(txReq));
          await txAave.wait();
          await emitTradeAlert("successful", pool, "Aave executed", {
            venue: "Aave", txHash: txAave.hash, profitUsd: estProfit.toFixed(2), kind
          });
        }
      }
    } catch (e) {
      console.warn("[Aave] broadcast failed:", e.message);
    }

    // ========== BALANCER EXECUTOR ==========
    try {
      const buyKind = pool.buyKind ?? detectKind(pool.buyRouter);
      const sellKind = pool.sellKind ?? detectKind(pool.sellRouter);

      const encodeBalancerUserData = (poolIdHex, userDataHex = "0x") => {
        if (!poolIdHex) return userDataHex;
        const pid = poolIdHex.toLowerCase().replace(/^0x/, "").padStart(64, "0");
        const rest = (userDataHex || "0x").replace(/^0x/, "");
        return "0x" + pid + rest;
      };

      const maybePoolId = pool.poolId || pool.balancerPoolId || pool.poolIdHex || null;
      const maybeUserData = pool.userDataHex || "0x";
      const v3PathBuy = (buyKind === SwapKind.BALANCER && maybePoolId) ? encodeBalancerUserData(maybePoolId, maybeUserData) : "0x";
      const v3PathSell = (sellKind === SwapKind.BALANCER && maybePoolId) ? encodeBalancerUserData(maybePoolId, maybeUserData) : "0x";

      const steps = [
        {
          kind: buyKind,
          router: pool.buyRouter,
          path: [tokenIn, tokenOut],
          v3Fee: 0,
          v3ExactInputSingle: false,
          v3Path: v3PathBuy,
          amountIn: normalizeToWei(pool.loanAmount),
          minAmountOut: BigInt(pool.minOut ?? 0),
          deadline: 0,
          unwrap: false,
        },
        {
          kind: sellKind,
          router: pool.sellRouter,
          path: [tokenOut, tokenIn],
          v3Fee: 0,
          v3ExactInputSingle: false,
          v3Path: v3PathSell,
          amountIn: BigInt(pool.minOut ?? 0),
          minAmountOut: BigInt(pool.minIn ?? 0),
          deadline: 0,
          unwrap: false,
        },
      ];

      const txData = balIface.encodeFunctionData("executeArbitrage", [
        {
          loanAssets: [pool.loanAsset],
          loanAmounts: [normalizeToWei(pool.loanAmount)],
          steps,
        },
      ]);

      const dryRes = await safeDryRun({ to: BALANCER_CONTRACT, data: txData });
      if (dryRes.success === false && !dryRes.skipped)
        await emitTradeAlert("skip", pool, "Balancer dry-run failed", { venue: "Balancer" });

      const gasObj = await getDynamicGas({ to: BALANCER_CONTRACT, data: txData }, 150);
      if (gasObj) {
        const txReq = { to: BALANCER_CONTRACT, data: txData, chainId: CHAIN_ID, nonce: await getNextNonce(), ...gasObj };
        const gasCostUsd = computeGasCostUsd(txReq.gasLimit, gasObj, gasTokenUsd);
        if (gasCostUsd <= estProfit) {
          txBal = await sendWithRetry(() => signer.sendTransaction(txReq));
          await txBal.wait();
          await emitTradeAlert("successful", pool, "Balancer executed", {
            venue: "Balancer", txHash: txBal.hash, profitUsd: estProfit.toFixed(2),
          });
        }
      }
    } catch (e) {
      console.warn("[Balancer] broadcast failed:", e.message);
    }

    if (!txAave && !txBal) return { status: "fail", reason: "both_failed" };
    return { status: "submitted", txHash: txAave?.hash || txBal?.hash };

  } catch (e) {
    console.error("[broadcast] Critical error:", e.message);
    await emitTradeAlert("fail", pool, `Critical broadcast error | ${e.message}`);
    return { status: "fail", reason: e.message };
  }
}

// ================================================
// --- SEQUENTIAL MULTI-BROADCAST ---
export async function broadcastSequentially(pools) {
  for (const pool of pools) {
    try {
      const result = await broadcastPendingPool(pool);
      console.log(result);
    } catch (e) {
      console.error(`[broadcast] Pool ${pool.id} failed:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}