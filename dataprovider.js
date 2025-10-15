// dataprovider.js — single RPC, auto-recovery, leading-zero hex fix
import 'dotenv/config';
import { ethers } from 'ethers';
import { WRITE_RPC_URL, POLYGON_CHAIN_ID } from './rpcConfig.js';

/* ----------------------------
   Fix for RPC leading-zero hex block arguments
---------------------------- */
function stripHexZeros(s) {
  if (typeof s !== 'string' || !s.startsWith('0x')) return s;
  let hex = s.slice(2).replace(/^0+/, '');
  if (hex.length === 0) hex = '0';
  return '0x' + hex.toLowerCase();
}

function toHexNoLead(n) {
  if (typeof n === 'bigint') return '0x' + n.toString(16);
  if (typeof n === 'number') return '0x' + Math.max(0, n >>> 0).toString(16);
  return n;
}

function normalizeBlockLike(x) {
  if (x == null) return x;
  if (['latest', 'earliest', 'pending', 'safe', 'finalized'].includes(x)) return x;

  if (typeof x === 'number' || typeof x === 'bigint') return toHexNoLead(x);
  if (typeof x === 'string' && /^0x[0-9a-fA-F]+$/.test(x)) return stripHexZeros(x);

  if (typeof x === 'object') {
    const y = { ...x };
    for (const k of ['blockNumber', 'blockTag', 'fromBlock', 'toBlock']) {
      if (y[k] != null) y[k] = normalizeBlockLike(y[k]);
    }
    return y;
  }

  return x;
}

function wrapProvider(p) {
  const origSend = p.send.bind(p);
  p.send = async (method, params = []) => {
    const fixedParams = params.map(normalizeBlockLike);
    return origSend(method, fixedParams);
  };
  return p;
}

/* ----------------------------
   Single shared provider
---------------------------- */
let currentProvider = null;

/* ----------------------------
   Get shared read provider
---------------------------- */
export async function getReadProvider() {
  if (!currentProvider) {
    currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
  }
  try {
    await currentProvider.getBlockNumber(); // lightweight test
  } catch (err) {
    console.warn(`[dataprovider] Provider failed, recreating...`);
    currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
  }
  return currentProvider;
}

/* ----------------------------
   Verify provider is on expected chain (production-safe)
---------------------------- */
export async function verifySameChain() {
  try {
    const provider = await getReadProvider();
    const network = await provider.getNetwork();

    const expectedChain = Number(String(POLYGON_CHAIN_ID).trim());
    const actualChain = Number(String(network.chainId).trim());

    if (actualChain !== expectedChain) {
      console.error(
        `[dataprovider] ❌ RPC chainId mismatch — expected ${expectedChain}, got ${actualChain}`
      );
      return false;
    }

    console.log(`✅ Verified RPC chainId: ${actualChain}`);
    return true;
  } catch (err) {
    console.error(`[dataprovider] ⚠️ verifySameChain failed:`, err?.message || err);
    return false;
  }
}

// Legacy alias for backward compatibility
export const ensurePolygonNetwork = verifySameChain;

/* ----------------------------
   Default export
---------------------------- */
export default {
  getReadProvider,
  verifySameChain,
  ensurePolygonNetwork,
};