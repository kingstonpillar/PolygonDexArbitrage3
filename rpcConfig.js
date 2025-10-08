// rpcConfig.js — Polygon Mainnet configuration with .env support (no timeout)

import "dotenv/config";

function parseRpcList(csv, fallbackList) {
  if (!csv || typeof csv !== "string") return fallbackList;
  return [
    ...new Set(
      csv
        .split(",")
        .map((u) => u.trim())
        .filter((u) => /^https?:\/\//i.test(u))
    ),
  ];
}

export const POLYGON_CHAIN_ID = Number(process.env.CHAIN_ID || 137);

export const WRITE_RPC_URL =
  process.env.WRITE_RPC_URL?.trim() ||
  "https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd";

export const POLYGON_RPCS = parseRpcList(
  process.env.POLYGON_RPCS,
  [
    "https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd",
    "https://polygon-mainnet.core.chainstack.com/c563a3c2726932e669d1cb5f72dfa75a",
    "https://polygon-mainnet.core.chainstack.com/e0149669ba321c1de3cd1d322d1e184d",
    "https://polygon-mainnet.public.blastapi.io",
  ]
);

export default {
  POLYGON_CHAIN_ID,
  WRITE_RPC_URL,
  POLYGON_RPCS,
};