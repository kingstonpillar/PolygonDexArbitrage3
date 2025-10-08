// dataprovider.js — global shared rotation, simple & safe
import 'dotenv/config';
import { ethers } from 'ethers';
import { POLYGON_RPCS, WRITE_RPC_URL } from './rpcConfig.js';

// ----------------------------
// Global provider state
// ----------------------------
let currentReadProvider = null;
let currentWriteProvider = null;
let rpcIndex = 0;
const readRpcs = Array.isArray(POLYGON_RPCS) ? POLYGON_RPCS : [POLYGON_RPCS];

// ----------------------------
// Rotate to next RPC (shared globally)
// ----------------------------
function rotateReadProvider() {
  rpcIndex = (rpcIndex + 1) % readRpcs.length;
  currentReadProvider = new ethers.JsonRpcProvider(readRpcs[rpcIndex]);
  console.log(`[dataprovider] Rotated to RPC: ${readRpcs[rpcIndex]}`);
}

// ----------------------------
// Get shared read provider
// ----------------------------
export async function getReadProvider() {
  if (!currentReadProvider) {
    currentReadProvider = new ethers.JsonRpcProvider(readRpcs[rpcIndex]);
  }

  try {
    // Lightweight call to verify provider is alive
    await currentReadProvider.getBlockNumber();
    return currentReadProvider;
  } catch (err) {
    console.warn(`[dataprovider] RPC failed: ${readRpcs[rpcIndex]}, rotating...`);
    rotateReadProvider(); // rotate to the next provider
    return currentReadProvider; // return the updated provider
  }
}

// ----------------------------
// Get write provider (single URL)
// ----------------------------
export async function getWriteProvider() {
  if (!currentWriteProvider) {
    currentWriteProvider = new ethers.JsonRpcProvider(WRITE_RPC_URL);
  }
  return currentWriteProvider;
}

// ----------------------------
// Verify first read RPC vs write provider
// ----------------------------
export async function verifySameChain() {
  const firstRpcProvider = new ethers.JsonRpcProvider(readRpcs[0]); // always first RPC
  const writeProvider = await getWriteProvider();

  const rNetwork = await firstRpcProvider.getNetwork();
  const wNetwork = await writeProvider.getNetwork();

  if (rNetwork.chainId !== wNetwork.chainId) {
    throw new Error(`First RPC and write provider are on different chains: ${rNetwork.chainId} vs ${wNetwork.chainId}`);
  }

  console.log(`[dataprovider] First RPC verified same chainId ${rNetwork.chainId} as write provider`);
  return true;
}

// ----------------------------
// ✅ Sniper: Ensure provider is on Polygon mainnet
// ----------------------------
export async function ensurePolygonNetwork(provider) {
  try {
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    if (chainId !== 137) {
      throw new Error(`Wrong chain — expected Polygon (137), got ${chainId}`);
    }
    console.log(`[dataprovider] ✅ Verified Polygon network (chainId ${chainId})`);
    return true;
  } catch (err) {
    console.error(`[dataprovider] ensurePolygonNetwork failed: ${err.message}`);
    throw err;
  }
}