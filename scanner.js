// scanner.js — ethers v6, dataprovider.js (HTTP-only, no rotateProvider)
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { getReadProvider, ensurePolygonNetwork } from './dataprovider.js';

/* =========================
   Paths & Config
========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEV_FILE = path.join(process.cwd(), 'mev_queue.json'); // shared with other modules

let routers = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, 'routers.json'), 'utf8');
  routers = JSON.parse(raw || '{}');
} catch {
  routers = {};
  console.warn('[scanner] routers.json missing/invalid; router-target checks will be reduced.');
}

const ROUTER_SET = new Set(
  Object.values(routers || {})
    .filter(v => typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v))
    .map(v => v.toLowerCase())
);

const HIGH_GAS_LIMIT = (() => {
  try { return ethers.parseUnits(String(process.env.HIGH_GAS_GWEI || '300'), 'gwei'); }
  catch { return ethers.parseUnits('300', 'gwei'); }
})();

/* =========================
   Retention (keep last N hours)
========================= */
const SCANNER_MEV_MAX_AGE_HOURS = Number(process.env.SCANNER_MEV_MAX_AGE_HOURS || 24);
const MAX_AGE_MS = Math.max(1, SCANNER_MEV_MAX_AGE_HOURS) * 60 * 60 * 1000;

function safeReadQueue() {
  try {
    if (!fs.existsSync(MEV_FILE)) return [];
    const raw = fs.readFileSync(MEV_FILE, 'utf8');
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function pruneMevQueue(now = Date.now()) {
  try {
    const queue = safeReadQueue();
    if (!Array.isArray(queue) || queue.length === 0) return 0;
    const cutoff = now - MAX_AGE_MS;
    const fresh = queue.filter(e => {
      const ts = Number(e?.timestamp || 0);
      return Number.isFinite(ts) && ts >= cutoff;
    });
    if (fresh.length !== queue.length) {
      fs.writeFileSync(MEV_FILE, JSON.stringify(fresh, null, 2));
      console.log(`[scanner] Pruned MEV queue: kept ${fresh.length}, removed ${queue.length - fresh.length} (> ${SCANNER_MEV_MAX_AGE_HOURS}h old)`);
      return queue.length - fresh.length;
    }
    return 0;
  } catch (e) {
    console.warn('[scanner] pruneMevQueue failed:', e?.message || e);
    return 0;
  }
}

(function schedulePrune() {
  pruneMevQueue();
  setInterval(pruneMevQueue, 60 * 60 * 1000);
})();

/* =========================
   ABIs & Interfaces (v6)
========================= */
const V2_IFACE = new ethers.Interface([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)'
]);

const V3_IFACE = new ethers.Interface([
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)',
  'function exactInput(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)',
  'function multicall(bytes[] data) returns (bytes[] results)'
]);

/* =========================
   Utils
========================= */
function logToMevQueue(entry) {
  pruneMevQueue();
  const queue = safeReadQueue();
  if (!queue.some(q => q.hash === entry.hash)) {
    queue.push(entry);
    fs.writeFileSync(MEV_FILE, JSON.stringify(queue, null, 2));
    console.log(`[scanner] MEV risk logged: ${entry.hash}`);
  }
}

function isRouterTarget(to) {
  if (!to) return false;
  try { return ROUTER_SET.has(String(to).toLowerCase()); } catch { return false; }
}

function getEffectiveGasPrice(tx) {
  return (tx.maxFeePerGas ?? tx.gasPrice) ?? null; // bigint in v6
}

function decodeV2Swap(data) {
  try {
    const parsed = V2_IFACE.parseTransaction({ data });
    const fn = parsed.name;
    if (fn === 'swapExactTokensForTokens') {
      const [amountIn, amountOutMin, path, to] = parsed.args;
      return { protocol: 'V2', method: fn, tokens: path.map(String), amountIn: amountIn.toString(), minOut: amountOutMin.toString(), recipient: String(to) };
    }
    if (fn === 'swapExactETHForTokens') {
      const [amountOutMin, path, to] = parsed.args;
      return { protocol: 'V2', method: fn, tokens: path.map(String), amountIn: 'NATIVE', minOut: amountOutMin.toString(), recipient: String(to) };
    }
    if (fn === 'swapExactTokensForETH') {
      const [amountIn, amountOutMin, path, to] = parsed.args;
      return { protocol: 'V2', method: fn, tokens: path.map(String), amountIn: amountIn.toString(), minOut: amountOutMin.toString(), recipient: String(to) };
    }
  } catch {}
  return null;
}

function decodeV3Path(pathBytes) {
  const tokens = [];
  const hex = String(pathBytes).startsWith('0x') ? String(pathBytes).slice(2) : String(pathBytes);
  let i = 0;
  while (i + 40 <= hex.length) {
    const tokenHex = '0x' + hex.slice(i, i + 40);
    let addr = tokenHex;
    try { addr = ethers.getAddress(tokenHex); } catch {}
    tokens.push(addr);
    i += 40;
    if (i + 6 > hex.length) break; // no room for next fee
    i += 6; // skip 3-byte fee
  }
  return tokens;
}

function decodeV3Swap(data) {
  try {
    const parsed = V3_IFACE.parseTransaction({ data });
    const fn = parsed.name;
    if (fn === 'exactInputSingle') {
      const p = parsed.args[0];
      return { protocol: 'V3', method: fn, tokens: [String(p.tokenIn), String(p.tokenOut)], amountIn: p.amountIn.toString(), minOut: p.amountOutMinimum.toString(), recipient: String(p.recipient), fee: Number(p.fee) };
    }
    if (fn === 'exactInput') {
      const [pathBytes, recipient, , amountIn, amountOutMinimum] = parsed.args;
      return { protocol: 'V3', method: fn, tokens: decodeV3Path(pathBytes), amountIn: amountIn.toString(), minOut: amountOutMinimum.toString(), recipient: String(recipient) };
    }
    if (fn === 'multicall') {
      const calls = parsed.args[0] || [];
      const inner = calls.map(c => decodeV2Swap(c) || decodeV3Swap(c)).filter(Boolean);
      if (inner.length) return { protocol: 'MULTICALL', method: 'multicall', inner };
    }
  } catch {}
  return null;
}

function decodeSwapCalldata(data) {
  return decodeV2Swap(data) || decodeV3Swap(data);
}

/* =========================
   RPC concurrency limiter
========================= */
const MAX_CONCURRENT_REQUESTS = 2;
const queue = [];
async function safeRpcCall(fn) {
  while (queue.length >= MAX_CONCURRENT_REQUESTS) {
    await new Promise(r => setTimeout(r, 50));
  }
  queue.push(1);
  try { return await fn(); } finally { queue.pop(); }
}

/* =========================
   Robust block fetch (fix for getBlockWithTransactions)
========================= */
async function fetchBlockWithTxs(p, bn) {
  // Normalize tag
  const tag = typeof bn === 'bigint' ? bn : BigInt(bn);

  // Attempt the high-level API first
  try {
    const blk = await p.getBlockWithTransactions(tag);
    if (blk && Array.isArray(blk.transactions)) return blk;
  } catch (e) {
    // fall through to raw RPC
  }

  // Raw RPC fallback
  try {
    const hexTag = ethers.toBeHex(tag); // 0x-quantity
    const raw = await p.send('eth_getBlockByNumber', [hexTag, true]);
    // Normalize a minimal ethers-like shape
    if (raw && Array.isArray(raw.transactions)) {
      return {
        ...raw,
        transactions: raw.transactions, // already expanded since we passed "true"
        number: raw.number ? Number(raw.number) : Number(tag),
      };
    }
  } catch (e) {
    throw new Error(`fetchBlockWithTxs fallback failed: ${e?.message || e}`);
  }

  return null;
}

/* =========================
   Scanner loop
========================= */
async function startScanner() {
  const label = '[READ]';

  // Ensure Polygon network
  try { await ensurePolygonNetwork(await getReadProvider()); }
  catch (e) { console.error(`${label} Wrong chain / RPC: ${e?.message || e}`); process.exit(2); }

  try {
    const p0 = await getReadProvider();
    const n = await p0.getNetwork();
    console.log(`${label} Connected (chainId ${Number(n?.chainId)})`);
  } catch {
    console.log(`${label} Connected`);
  }

  let lastProcessed = 0;
  const pollIntervalMs = 1500;

  async function scanLatestBlock() {
    try {
      const p = await getReadProvider();
      const bn = await safeRpcCall(() => p.getBlockNumber());
      if (lastProcessed && bn <= lastProcessed) return;

      const block = await safeRpcCall(() => fetchBlockWithTxs(p, bn)); // << FIX HERE
      if (!block || !Array.isArray(block.transactions)) { lastProcessed = bn; return; }

      for (const tx of block.transactions) {
        const effGas = getEffectiveGasPrice(tx);
        const gasIsHigh = effGas ? (effGas > HIGH_GAS_LIMIT) : false; // bigint compare
        const hitsRouter = isRouterTarget(tx.to);

        let decoded = null;
        if (hitsRouter || gasIsHigh) {
          if (tx.data && tx.data !== '0x') decoded = decodeSwapCalldata(tx.data);
        }

        if (gasIsHigh || hitsRouter || decoded) {
          const entry = { hash: tx.hash, from: tx.from, to: tx.to, gasPrice: effGas?.toString() ?? null, timestamp: Date.now() };
          if (decoded) entry.decoded = decoded;
          if (tx.value) entry.txValue = tx.value.toString();
          logToMevQueue(entry);
        }
      }

      lastProcessed = bn;
    } catch (error) {
      console.warn(`${label} Error scanning block: ${error?.message || error}`);
    }
  }

  setInterval(scanLatestBlock, pollIntervalMs);

  // Heartbeat
  setInterval(async () => {
    try {
      const p = await getReadProvider();
      await safeRpcCall(() => p.getBlockNumber());
    } catch {
      console.warn(`${label} Heartbeat failed. Skipping rotateProvider (handled by dataprovider)`);
    }
  }, 15000);
}

startScanner();
