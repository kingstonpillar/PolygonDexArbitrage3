// PrivateRPC.js — Polygon-only private RPC rotation with POL gas + Telegram alerts
import dotenv from "dotenv";
import { ethers } from "ethers";
import { sendTelegram } from "./telegramalert.js";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const URL_LIST = process.env.PRIVATE_RPC_URLS?.split(",").map(u => u.trim()).filter(Boolean);

if (!URL_LIST?.length) throw new Error("❌ Missing PRIVATE_RPC_URLS in .env");
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE_KEY in .env");

let _provider = null;
let _signer = null;
let _cachedNonce = null;
let _currentIndex = 0;

// =====================================================
//  ROTATE AMONG PRIVATE RPCS
// =====================================================
function pickNextRpcUrl() {
  _currentIndex = (_currentIndex + 1) % URL_LIST.length;
  return URL_LIST[_currentIndex];
}

export async function getProvider() {
  if (_provider) return _provider;
  const url = URL_LIST[_currentIndex];
  try {
    _provider = new ethers.JsonRpcProvider(url, 137); // Polygon mainnet only
    console.log(`[PrivateRPC] ✅ Connected to Polygon RPC: ${url}`);
    await sendTelegram(`🟣 Connected to Polygon RPC: ${url}`);
    return _provider;
  } catch (e) {
    console.warn(`[PrivateRPC] Failed to connect ${url}:`, e.message);
    const next = pickNextRpcUrl();
    console.log(`[PrivateRPC] Retrying with ${next}`);
    _provider = new ethers.JsonRpcProvider(next, 137);
    await sendTelegram(`⚠️ RPC switched to: ${next}`);
    return _provider;
  }
}

// =====================================================
//  NONCE MANAGEMENT
// =====================================================
export async function getNextNonce() {
  const provider = await getProvider();
  if (!_signer) _signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const addr = await _signer.getAddress();

  if (_cachedNonce === null) {
    _cachedNonce = await provider.getTransactionCount(addr, "latest");
  } else {
    _cachedNonce += 1;
  }

  console.log(`[PrivateRPC] Nonce: ${_cachedNonce}`);
  return _cachedNonce;
}

// =====================================================
//  SAFE TRANSACTION SENDER WITH RETRY + ALERTS
// =====================================================
export async function sendWithRetry(sendFn, maxRetries = 3, delayMs = 1500) {
  let lastError = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const tx = await sendFn();
      if (tx?.hash) {
        const gasPrice = tx.maxFeePerGas || tx.gasPrice
          ? Number(ethers.formatUnits(tx.maxFeePerGas || tx.gasPrice, "gwei")).toFixed(2)
          : "unknown";
        const nonce = tx.nonce ?? "unknown";

        console.log(`[PrivateRPC] ✅ Tx sent: ${tx.hash} | nonce=${nonce} | gas=${gasPrice} gwei`);

        await sendTelegram(
          `✅ *Tx Sent on Polygon*\n` +
          `Hash: [${tx.hash}](https://polygonscan.com/tx/${tx.hash})\n` +
          `Nonce: ${nonce}\n` +
          `Gas: ${gasPrice} gwei\n` +
          `RPC: ${URL_LIST[_currentIndex]}`
        );

        return tx;
      }
      throw new Error("Empty tx response");
    } catch (err) {
      lastError = err;
      const msg = err.message || "unknown";
      console.warn(`[PrivateRPC] Retry ${i + 1}/${maxRetries}: ${msg}`);

      const next = pickNextRpcUrl();
      console.log(`[PrivateRPC] 🔁 Switching RPC to ${next}`);
      _provider = new ethers.JsonRpcProvider(next, 137);
      _signer = new ethers.Wallet(PRIVATE_KEY, _provider);

      await sendTelegram(
        `⚠️ *Tx Retry ${i + 1}/${maxRetries}*\n` +
        `Error: ${msg}\n` +
        `Switching to RPC: ${next}`
      );

      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }

  console.error("[PrivateRPC] ❌ All retries failed:", lastError?.message);
  await sendTelegram(`❌ *Tx Failed on Polygon*\nError: ${lastError?.message}`);
  throw lastError;
}