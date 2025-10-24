// broadcast.js
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { ethers, Wallet } from "ethers";

import { getProvider, getNextNonce, sendWithRetry } from "./PrivateRPC.js";
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

// Private provider for sending transactions only (PrivateRPC returns your write provider)
const privateProvider = await getProvider();
const signer = new Wallet(PRIVATE_KEY, privateProvider);

// ================================================
// --- HELPERS ---
function normalizeToBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.floor(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  try {
    return BigInt(Math.floor(Number(value || 0)));
  } catch {
    return 0n;
  }
}

// --- Get MATIC or POL price from Coingecko ---
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

// --- Gas Estimation ---
async function getDynamicGas(txReq, boostPercent = 100) {
  try {
    const gasProv = wsProvider || privateProvider;
    const gasEstimate = await gasProv.estimateGas(txReq); // BigInt
    const baseFee = await gasProv.getFeeData();
    const maxFee = baseFee.maxFeePerGas ?? baseFee.gasPrice ?? BigInt(0);
    const maxPriority =
      baseFee.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei");

    const boost = boostPercent / 100;
    const boostedMaxFee = BigInt(Math.floor(Number(maxFee) * (1 + boost)));
    const boostedPriority = BigInt(
      Math.floor(Number(maxPriority) * (1 + boost))
    );

    return {
      gasLimit: gasEstimate,
      maxFeePerGas: boostedMaxFee,
      maxPriorityFeePerGas: boostedPriority,
    };
  } catch (e) {
    console.warn("[broadcast] Gas estimation failed:", e.message);
    return null; // explicit null to indicate failure
  }
}

// helper: safe compute gas cost (returns number USD)
function computeGasCostUsd(gasLimit, maxFeePerGas, gasTokenUsd) {
  try {
    if (!gasLimit || !maxFeePerGas) return Number.POSITIVE_INFINITY;
    const costWei = gasLimit * maxFeePerGas; // BigInt
    const costNative = Number(costWei) / 1e18;
    return costNative * gasTokenUsd;
  } catch (e) {
    console.warn("[broadcast] computeGasCostUsd failed:", e.message);
    return Number.POSITIVE_INFINITY;
  }
}

// ================================================
// --- MAIN FUNCTION ---
export async function broadcastPendingPool(pool) {
  if (!pool || !pool.loanAsset) {
    console.warn("[broadcast] Invalid pool received");
    return { status: "skip", reason: "invalid_pool" };
  }

  const estProfit = Number(pool.profitUSD || pool.estProfitUSD || 0);
  const id = pool.id || null;
  let txAave = null;
  let txBal = null;

  try {
    const tokenIn = pool.tokenIn || pool.loanAsset;
    const tokenOut = pool.tokenOut || pool.sellAsset || pool.targetToken;
    const gasTokenUsd = await getGasTokenPrice();

    // Convenience interfaces (ethers v6)
    const aaveIface = new ethers.Interface(aaveABI);
    const balIface = new ethers.Interface(balancerABI);

    // --- AAVE PATH ---
    try {
      const txData = aaveIface.encodeFunctionData("executeArbitrage", [
        {
          loanAssets: [pool.loanAsset],
          loanAmounts: [normalizeToBigInt(pool.loanAmount)],
          steps: [
            {
              kind: 0,
              router: pool.buyRouter,
              path: [tokenIn, tokenOut],
              v3Fee: 0,
              v3ExactInputSingle: false,
              v3Path: "0x",
              amountIn: normalizeToBigInt(pool.loanAmount),
              minAmountOut: BigInt(pool.minOut ?? 0),
              deadline: 0,
              unwrapETH: false,
            },
            {
              kind: 0,
              router: pool.sellRouter,
              path: [tokenOut, tokenIn],
              v3Fee: 0,
              v3ExactInputSingle: false,
              v3Path: "0x",
              amountIn: BigInt(pool.minOut ?? 0),
              minAmountOut: BigInt(pool.minIn ?? 0),
              deadline: 0,
              unwrapETH: false,
            },
          ],
        },
      ]);

      let txReq = { to: AAVE_CONTRACT, data: txData, chainId: CHAIN_ID };

      const gasObj = await getDynamicGas(txReq, 100);
      if (!gasObj) {
        // Can't safely estimate gas — signal skip
        await emitTradeAlert("skip", pool, "Aave gas estimate failed", {
          venue: "Aave",
        });
      } else {
        txReq.gasLimit = gasObj.gasLimit;
        txReq.maxFeePerGas = gasObj.maxFeePerGas;
        txReq.maxPriorityFeePerGas = gasObj.maxPriorityFeePerGas;

        const gasCostUsd = computeGasCostUsd(
          txReq.gasLimit,
          txReq.maxFeePerGas,
          gasTokenUsd
        );

        if (gasCostUsd > estProfit) {
          await emitTradeAlert("skip", pool, "Aave gas>profit", { venue: "Aave" });
        } else {
          const nonce = await getNextNonce();
          txReq.nonce = nonce;

          try {
            txAave = await sendWithRetry(async () => await signer.sendTransaction(txReq));
            await txAave.wait();
            await emitTradeAlert("successful", pool, "Aave executed", {
              venue: "Aave",
              txHash: txAave.hash,
              profitUsd: estProfit.toFixed(2),
            });
          } catch (sendErr) {
            await emitTradeAlert("fail", pool, `Aave send failed | ${sendErr.message}`, {
              venue: "Aave",
            });
          }
        }
      }
    } catch (e) {
      await emitTradeAlert("fail", pool, `Aave failed | ${e.message}`, {
        venue: "Aave",
      });
    }

    // --- BALANCER PATH ---
    try {
      const txData = balIface.encodeFunctionData("executeArbitrage", [
        {
          loanAssets: [pool.loanAsset],
          loanAmounts: [normalizeToBigInt(pool.loanAmount)],
          steps: [
            {
              kind: 0,
              router: pool.buyRouter,
              path: [tokenIn, tokenOut],
              v3Fee: 0,
              v3ExactInputSingle: false,
              v3Path: "0x",
              amountIn: normalizeToBigInt(pool.loanAmount),
              minAmountOut: BigInt(pool.minOut ?? 0),
              deadline: 0,
              unwrap: false,
            },
            {
              kind: 0,
              router: pool.sellRouter,
              path: [tokenOut, tokenIn],
              v3Fee: 0,
              v3ExactInputSingle: false,
              v3Path: "0x",
              amountIn: BigInt(pool.minOut ?? 0),
              minAmountOut: BigInt(pool.minIn ?? 0),
              deadline: 0,
              unwrap: false,
            },
          ],
        },
      ]);

      let txReq = { to: BALANCER_CONTRACT, data: txData, chainId: CHAIN_ID };

      const gasObj = await getDynamicGas(txReq, 100);
      if (!gasObj) {
        await emitTradeAlert("skip", pool, "Balancer gas estimate failed", {
          venue: "Balancer",
        });
      } else {
        txReq.gasLimit = gasObj.gasLimit;
        txReq.maxFeePerGas = gasObj.maxFeePerGas;
        txReq.maxPriorityFeePerGas = gasObj.maxPriorityFeePerGas;

        const gasCostUsd = computeGasCostUsd(
          txReq.gasLimit,
          txReq.maxFeePerGas,
          gasTokenUsd
        );

        if (gasCostUsd > estProfit) {
          await emitTradeAlert("skip", pool, "Balancer gas>profit", {
            venue: "Balancer",
          });
        } else {
          const nonce = await getNextNonce();
          txReq.nonce = nonce;

          try {
            txBal = await sendWithRetry(async () => await signer.sendTransaction(txReq));
            await txBal.wait();
            await emitTradeAlert("successful", pool, "Balancer executed", {
              venue: "Balancer",
              txHash: txBal.hash,
              profitUsd: estProfit.toFixed(2),
            });
          } catch (sendErr) {
            await emitTradeAlert("fail", pool, `Balancer send failed | ${sendErr.message}`, {
              venue: "Balancer",
            });
          }
        }
      }
    } catch (e) {
      await emitTradeAlert("fail", pool, `Balancer failed | ${e.message}`, {
        venue: "Balancer",
      });
    }

    if (!txAave && !txBal) return { status: "fail", reason: "both_failed" };
    return { status: "submitted", txHash: txAave?.hash || txBal?.hash };
  } catch (e) {
    console.error("[broadcast] Critical error:", e.message);
    await emitTradeAlert("fail", pool, `Critical broadcast error | ${e.message}`);
    return { status: "fail", reason: e.message };
  }
}