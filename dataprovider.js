// dataprovider.js — pure ethers v6 style, no limiter, no quotas, no proxy

import "dotenv/config";
import { ethers } from "ethers";
import { POLYGON_CHAIN_ID, POLYGON_RPCS, WRITE_RPC_URL } from "./rpcConfig.js";

// -----------------------------------------------------------
// Provider rotation (simple index-based cycle)
// -----------------------------------------------------------
let currentIndex = 0;

/**
 * Get the current read provider (rotates among POLYGON_RPCS)
 */
export function getReadProvider() {
  const url = POLYGON_RPCS[currentIndex % POLYGON_RPCS.length];
  const provider = new ethers.JsonRpcProvider(url, {
    chainId: POLYGON_CHAIN_ID,
    name: "polygon",
  });
  return provider;
}

/**
 * Rotate to the next provider in POLYGON_RPCS
 */
export function rotateProvider(reason = "manual") {
  currentIndex = (currentIndex + 1) % POLYGON_RPCS.length;
  console.log(
    `[dataprovider] RPC rotated (${reason}) → ${POLYGON_RPCS[currentIndex]}`
  );
}

/**
 * Get the write provider (used for transaction broadcast)
 */
export function getWriteProvider() {
  return new ethers.JsonRpcProvider(WRITE_RPC_URL, {
    chainId: POLYGON_CHAIN_ID,
    name: "polygon",
  });
}

/**
 * Ensure connected provider is on Polygon (chainId = 137)
 */
export async function ensurePolygonNetwork(provider) {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(POLYGON_CHAIN_ID)) {
    throw new Error(
      `Invalid network: expected ${POLYGON_CHAIN_ID}, got ${Number(net.chainId)}`
    );
  }
  return true;
}

export default {
  getReadProvider,
  getWriteProvider,
  rotateProvider,
  ensurePolygonNetwork,
};