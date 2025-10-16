// dataprovider.js — single RPC, optional WebSocket, auto-recovery, leading-zero hex fix, fast block detection, auto WS reconnect
import 'dotenv/config';
import { ethers } from 'ethers';
import { WRITE_RPC_URL, POLYGON_CHAIN_ID } from './rpcConfig.js';

const RPC_WS = process.env.RPC_WS_URL || '';

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

let currentProvider = null;
let isWS = false;

/* ----------------------------
   Initialize WS or HTTP provider
---------------------------- */
async function initProvider() {
  if (RPC_WS && !isWS) {
    try {
      const wsProvider = new ethers.WebSocketProvider(RPC_WS);
      currentProvider = wrapProvider(wsProvider);
      isWS = true;

      wsProvider.on('block', (blockNumber) => {
        console.debug(`[dataprovider] New WS block: ${blockNumber}`);
      });

      wsProvider._websocket.on('close', (code) => {
        console.warn(`⚠️ WS closed (${code}), switching to HTTP`);
        currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
        isWS = false;
      });

      wsProvider._websocket.on('error', (err) => {
        console.warn('⚠️ WS error, switching to HTTP:', err);
        currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
        isWS = false;
      });

      console.log('✅ Using WebSocket provider for blocks/events');
      return currentProvider;
    } catch {
      console.warn('[dataprovider] WS init failed, using HTTP');
      currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
      isWS = false;
      return currentProvider;
    }
  }

  // fallback to HTTP
  if (!currentProvider) {
    currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
    isWS = false;
    console.log('✅ Using HTTP provider');
  }

  return currentProvider;
}

/* ----------------------------
   Periodic WS reconnect (every 30s)
---------------------------- */
setInterval(async () => {
  if (!isWS && RPC_WS) {
    try {
      console.log('[dataprovider] Attempting WS reconnect...');
      const wsTest = new ethers.WebSocketProvider(RPC_WS);
      await wsTest.getBlockNumber();
      console.log('✅ WS back online, switching provider');
      currentProvider = wrapProvider(wsTest);
      isWS = true;

      wsTest.on('block', (bn) => console.debug(`[dataprovider] New WS block: ${bn}`));
      wsTest._websocket.on('close', (code) => {
        console.warn(`⚠️ WS closed (${code}), switching to HTTP`);
        currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
        isWS = false;
      });
      wsTest._websocket.on('error', (err) => {
        console.warn('⚠️ WS error, switching to HTTP:', err);
        currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
        isWS = false;
      });
    } catch {
      // still down, ignore
    }
  }
}, 30000);

/* ----------------------------
   Exported function
---------------------------- */
export async function getReadProvider() {
  if (currentProvider) return currentProvider;
  return await initProvider();
}

// ---------------------------
// Safe chain verification
// ---------------------------
export async function verifySameChainSafe() {
  try {
    const provider = await getReadProvider();
    const network = await provider.getNetwork();
    const expectedChain = Number(String(POLYGON_CHAIN_ID).trim());
    const actualChain = Number(String(network.chainId).trim());

    if (actualChain !== expectedChain) {
      console.error(`[dataprovider] ❌ RPC chainId mismatch — expected ${expectedChain}, got ${actualChain}`);
      return false;
    }

    console.log(`✅ Verified RPC chainId: ${actualChain}`);
    return true;
  } catch (err) {
    console.warn(`[dataprovider] ⚠️ Safe verifySameChain failed:`, err?.message || err);
    return false;
  }
}

// ---------------------------
// Periodic non-blocking verification
// ---------------------------
setInterval(async () => {
  const ok = await verifySameChainSafe();
  if (!ok) {
    console.warn('Chain verification failed. Will retry, but WS keeps running.');
  }
}, 30000); // every 30 seconds

export const verifySameChain = verifySameChainSafe; // alias for backward compatibility
export const ensurePolygonNetwork = verifySameChainSafe;


// Default export
// ---------------------------
export default {
  getReadProvider,
  verifySameChain: verifySameChainSafe,
  ensurePolygonNetwork: verifySameChainSafe,
};
