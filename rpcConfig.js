// rpcConfig.js — Polygon Mainnet configuration with .env support (Alchemy only)

import "dotenv/config";

/**
 * Parse comma-separated list of RPCs from .env
 * Only keeps valid HTTP(S) URLs
 */
function parseRpcList(csv) {
  if (!csv || typeof csv !== "string") return [];
  return [
    ...new Set(
      csv
        .split(",")
        .map((u) => u.trim())
        .filter((u) => /^https?:\/\//i.test(u))
    ),
  ];
}

// Polygon chain ID
export const POLYGON_CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// Write provider — only Alchemy
export const WRITE_RPC_URL =
  process.env.WRITE_RPC_URL?.trim() ||
  "https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd";

// Read RPCs — only from .env POLYGON_RPCS
export const POLYGON_RPCS = parseRpcList(process.env.POLYGON_RPCS);

// Validate that at least one RPC exists
if (!POLYGON_RPCS.length) {
  throw new Error(
    "[rpcConfig] No POLYGON_RPCS configured in .env! Please set POLYGON_RPCS with Alchemy URL(s)."
  );
}

export default {
  POLYGON_CHAIN_ID,
  WRITE_RPC_URL,
  POLYGON_RPCS,
};