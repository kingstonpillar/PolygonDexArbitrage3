// rpcConfig.js — Polygon Mainnet configuration with .env support (cleaned, Amoy removed)

import "dotenv/config"; // Load .env variables first

// ---------------------------
// Helper functions
// ---------------------------
function toNumber(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function parseRpcList(csv, fallbackList) {
  if (!csv || typeof csv !== "string") return dedupeUrls(fallbackList);
  const arr = csv
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return dedupeUrls(arr.length ? arr : fallbackList);
}

function dedupeUrls(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const u of list) {
    if (typeof u !== "string") continue;
    const s = u.trim();
    if (!s || !/^https?:\/\//i.test(s)) continue;
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// ---------------------------
// CHAIN ID (Mainnet only)
// ---------------------------
export const POLYGON_CHAIN_ID = toNumber(process.env.CHAIN_ID, 137); // Polygon Mainnet = 137

// ---------------------------
// WRITE RPC (Mainnet Alchemy fallback)
// ---------------------------
export const WRITE_RPC_URL =
  (process.env.WRITE_RPC_URL && process.env.WRITE_RPC_URL.trim()) ||
  "https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd";

// ---------------------------
// READ RPCs (Alchemy first, then Chainstack + Blast)
// ---------------------------
export const POLYGON_RPCS = parseRpcList(
  process.env.POLYGON_RPCS,
  [
    "https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd", // ✅ first (Alchemy)
    "https://polygon-mainnet.core.chainstack.com/c563a3c2726932e669d1cb5f72dfa75a",
    "https://polygon-mainnet.core.chainstack.com/e0149669ba321c1de3cd1d322d1e184d",
    "https://polygon-mainnet.core.chainstack.com/c985c973d8bb05b487cdaa92c949a595",
    "https://polygon-mainnet.public.blastapi.io",
  ]
);

// ---------------------------
// READ RPC Timeout (ms)
// ---------------------------
export const READ_RPC_TIMEOUT_MS = toNumber(process.env.READ_RPC_TIMEOUT_MS, 5000);

// ---------------------------
// Validation checks
// ---------------------------
if (!WRITE_RPC_URL) throw new Error("WRITE_RPC_URL is missing in .env or fallback");
if (!Array.isArray(POLYGON_RPCS) || POLYGON_RPCS.length === 0)
  throw new Error("POLYGON_RPCS is empty");
if (
  !Number.isFinite(POLYGON_CHAIN_ID) ||
  POLYGON_CHAIN_ID <= 0 ||
  !Number.isInteger(POLYGON_CHAIN_ID)
)
  throw new Error(`Invalid CHAIN_ID: ${String(process.env.CHAIN_ID)}`);

const allUrls = [WRITE_RPC_URL, ...POLYGON_RPCS];
for (const url of allUrls) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid RPC URL (must start with http/https): ${url}`);
  }
}

// ---------------------------
// Export ready to use
// ---------------------------
export default {
  POLYGON_CHAIN_ID,
  WRITE_RPC_URL,
  POLYGON_RPCS,
  READ_RPC_TIMEOUT_MS,
};