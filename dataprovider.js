// dataprovider.js — HTTP-only provider, hex cleanup, chain verification
import "dotenv/config";
import { ethers } from "ethers";

const WRITE_RPC_URL = process.env.WRITE_RPC_URL;
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// ----------------------------
//   🧹 HEX NORMALIZATION
// ----------------------------
function stripHexZeros(s) {
  if (typeof s !== "string" || !s.startsWith("0x")) return s;
  let hex = s.slice(2).replace(/^0+/, ""); // remove leading zeros
  if (hex.length === 0) hex = "0";
  return "0x" + hex.toLowerCase();
}

function toHexNoLead(n) {
  if (typeof n === "bigint") return "0x" + n.toString(16);
  if (typeof n === "number") return "0x" + Math.max(0, n >>> 0).toString(16);
  return n;
}

function normalizeBlockLike(x) {
  if (x == null) return x;

  const presetTags = ["latest", "earliest", "pending", "safe", "finalized"];
  if (presetTags.includes(x)) return x;

  if (typeof x === "number" || typeof x === "bigint") return toHexNoLead(x);
  if (typeof x === "string" && /^0x[0-9a-fA-F]+$/.test(x)) return stripHexZeros(x);

  if (typeof x === "object") {
    const y = { ...x };
    for (const k of ["blockNumber", "blockTag", "fromBlock", "toBlock"]) {
      if (y[k] != null) y[k] = normalizeBlockLike(y[k]);
    }
    return y;
  }

  return x;
}

// ----------------------------
//   ✅ WRAP PROVIDER SEND()
// ----------------------------
function wrapProvider(provider) {
  const origSend = provider.send.bind(provider);
  provider.send = async (method, params = []) => {
    const fixedParams = params.map(normalizeBlockLike);
    return origSend(method, fixedParams);
  };
  return provider;
}

// ----------------------------
//   🚀 SINGLE HTTP PROVIDER
// ----------------------------
let provider = null;

/**
 * Ensures the HTTP provider exists (lazy init)
 */
export async function getReadProvider() {
  if (!provider) {
    provider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
    console.log(`✅ dataprovider using HTTP RPC → ${WRITE_RPC_URL}`);
  }
  return provider;
}

// ----------------------------
// 🔒 Safe chain ID check
// ----------------------------
export async function verifySameChainSafe() {
  try {
    const provider = await getReadProvider();
    const network = await provider.getNetwork();

    if (Number(network.chainId) !== CHAIN_ID) {
      console.error(
        `❌ RPC chain mismatch — expected ${CHAIN_ID}, got ${network.chainId}`
      );
      return false;
    }

    console.log(`✅ RPC chain verified → ${network.chainId}`);
    return true;
  } catch (err) {
    console.warn(`[dataprovider] verifySameChainSafe() error:`, err.message);
    return false;
  }
}

// periodic check (does NOT block execution)
setInterval(() => {
  verifySameChainSafe();
}, 30000);

export default {
  getReadProvider,
  verifySameChain: verifySameChainSafe,
  ensurePolygonNetwork: verifySameChainSafe,
};