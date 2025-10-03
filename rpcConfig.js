// rpcConfig.js — Polygon RPC configuration with .env support

import "dotenv/config"; // Load .env variables at the very top

// ---------------------------
// CHAIN ID
// ---------------------------
export const POLYGON_CHAIN_ID = Number(process.env.POLYGON_CHAIN_ID || 137);

// ---------------------------
// WRITE RPC
// ---------------------------
export const WRITE_RPC_URL =
  (process.env.WRITE_RPC_URL && process.env.WRITE_RPC_URL.trim()) ||
  "https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd"; // ← semicolon (fixed)

// ---------------------------
// READ RPCs
// Comma-separated in .env, fallback to hardcoded list
// Example .env: POLYGON_RPCS=https://rpc1,https://rpc2,https://rpc3
// ---------------------------
export const POLYGON_RPCS = process.env.POLYGON_RPCS
  ? process.env.POLYGON_RPCS.split(",")
      .map((u) => u.trim())
      .filter(Boolean)
  : [
      "https://polygon-mainnet.core.chainstack.com/c563a3c2726932e669d1cb5f72dfa75a",
      "https://polygon-mainnet.core.chainstack.com/e0149669ba321c1de3cd1d322d1e184d",
      "https://polygon-mainnet.core.chainstack.com/c985c973d8bb05b487cdaa92c949a595",
      "https://polygon-mainnet.public.blastapi.io",
    ];

// ---------------------------
// READ RPC Timeout (ms)
// ---------------------------
export const READ_RPC_TIMEOUT_MS = Number(process.env.READ_RPC_TIMEOUT_MS || 1500);

// ---------------------------
// Validation checks
// ---------------------------
if (!WRITE_RPC_URL) throw new Error("WRITE_RPC_URL is missing in .env or fallback");
if (!Array.isArray(POLYGON_RPCS) || POLYGON_RPCS.length === 0)
  throw new Error("POLYGON_RPCS is empty");
if (!Number.isFinite(POLYGON_CHAIN_ID) || POLYGON_CHAIN_ID <= 0 || !Number.isInteger(POLYGON_CHAIN_ID))
  throw new Error(`Invalid POLYGON_CHAIN_ID: ${String(process.env.POLYGON_CHAIN_ID)}`);

// ---------------------------
// Export ready to use
// ---------------------------
export default {
  POLYGON_CHAIN_ID,
  WRITE_RPC_URL,
  POLYGON_RPCS,
  READ_RPC_TIMEOUT_MS,
};
