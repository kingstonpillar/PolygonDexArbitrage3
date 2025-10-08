// dataprovider.js — ESM, v6-style, auto-rotate on dead provider
import 'dotenv/config';
import { ethers } from 'ethers';

import { POLYGON_RPCS, WRITE_RPC_URL } from './rpcConfig.js';

// ============================
// Provider state
// ============================
let readProvider = null;
let writeProvider = null;
let readIndex = 0;
const readRpcs = Array.isArray(POLYGON_RPCS) ? POLYGON_RPCS : [POLYGON_RPCS];

// ============================
// Get a live read provider (auto-rotate if current fails)
// ============================
export async function getReadProvider() {
  if (!readProvider) {
    readProvider = new ethers.JsonRpcProvider(readRpcs[readIndex]);
  }

  try {
    // Try a lightweight call to confirm the provider is alive
    await readProvider.getBlockNumber();
    return readProvider;
  } catch (err) {
    console.warn(`[dataprovider] Read RPC failed: ${readRpcs[readIndex]}, rotating...`);
    // rotate to next RPC
    readIndex = (readIndex + 1) % readRpcs.length;
    readProvider = new ethers.JsonRpcProvider(readRpcs[readIndex]);
    return readProvider;
  }
}

// ============================
// Get write provider (single URL from env)
// ============================
export async function getWriteProvider() {
  if (!writeProvider) {
    writeProvider = new ethers.JsonRpcProvider(WRITE_RPC_URL);
  }
  return writeProvider;
}

// ============================
// Verify both providers are on same chain
// ============================
export async function verifySameChain() {
  const r = await getReadProvider();
  const w = await getWriteProvider();

  const rNetwork = await r.getNetwork();
  const wNetwork = await w.getNetwork();

  if (rNetwork.chainId !== wNetwork.chainId) {
    throw new Error(`Read/Write providers are on different chains: ${rNetwork.chainId} vs ${wNetwork.chainId}`);
  }

  console.log(`[dataprovider] Providers verified on chainId ${rNetwork.chainId}`);
  return true;
}