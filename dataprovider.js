// dataprovider.js — robust, queue-based limiter, strict static network for ethers v6
// Logic preserved; fixes ethers v6 chainId/network mismatches

import { POLYGON_CHAIN_ID, POLYGON_RPCS, WRITE_RPC_URL, READ_RPC_TIMEOUT_MS } from "./rpcConfig.js";
import { ethers } from "ethers";
import { sendTelegramAlert } from "./telegramalert.js";

// ==================================================
// CONFIG: quotas + threshold
// ==================================================
const QUOTAS = {
  alchemy: 100_000,
  infura: 3_000_000,
  getblock: 50_000,
  chainstack: 50_000,
  official: 100_000,
  default: 100_000,
};
const RPC_THRESHOLD = 0.8;

// ==================================================
// CHAIN ID NORMALIZATION
// ==================================================
function normalizeChainId(v) {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid POLYGON_CHAIN_ID: ${String(v)}`);
  }
  return n;
}

const CHAIN_ID = normalizeChainId(POLYGON_CHAIN_ID);
const NETWORKISH = { name: "polygon", chainId: CHAIN_ID }; // ethers v6 accepts Networkish

// ==================================================
// INPUT SANITY
// ==================================================
const _arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const READ_RPC_URLS = _arr(POLYGON_RPCS).filter((u) => typeof u === "string" && u.length > 0);
const WRITE_RPC_URLS = [WRITE_RPC_URL, ...READ_RPC_URLS].filter(Boolean);
if (READ_RPC_URLS.length === 0) {
  throw new Error("POLYGON_RPCS is empty or invalid");
}

// ==================================================
// USAGE TRACKING
// ==================================================
const rpcUsage = {};
[...WRITE_RPC_URLS, ...READ_RPC_URLS].forEach((url) => (rpcUsage[url] = 0));

function detectType(url) {
  if (!url) return "default";
  if (url.includes("alchemy")) return "alchemy";
  if (url.includes("infura")) return "infura";
  if (url.includes("getblock")) return "getblock";
  if (url.includes("chainstack")) return "chainstack";
  if (url.includes("polygon-rpc")) return "official";
  return "default";
}

// ==================================================
// CONCURRENCY LIMITER (queue-based, FIFO, with max size)
// ==================================================
const MAX_CONCURRENT_REQUESTS = 12;  // 🔧 active at once
const MAX_QUEUE_SIZE = 1000;         // 🔧 prevent unbounded backlog

let active = 0;
const waiters = [];

async function safeRpcCall(fn) {
  // If too many waiting, reject immediately
  if (waiters.length >= MAX_QUEUE_SIZE) {
    throw new Error(`RPC queue overflow: >${MAX_QUEUE_SIZE} pending`);
  }

  // If concurrency cap reached, enqueue
  if (active >= MAX_CONCURRENT_REQUESTS) {
    await new Promise((resolve) => waiters.push(resolve));
  }

  active++;
  try {
    return await fn();
  } finally {
    active--;
    if (waiters.length > 0) {
      const next = waiters.shift();
      next();
    }
  }
}

// ==================================================
// TRACKING + ROTATION
// ==================================================
async function trackUsageAndRotate(url, type = "read") {
  const provType = detectType(url);
  const quota = QUOTAS[provType] ?? QUOTAS.default;

  rpcUsage[url] = (rpcUsage[url] || 0) + 1;
  const usagePercent = rpcUsage[url] / quota;

  if (usagePercent >= RPC_THRESHOLD) {
    const msg = `⚠️ ${type.toUpperCase()} RPC *${provType}* hit ${Math.floor(usagePercent * 100)}% quota\nRotating from:\n${url}`;
    try { await sendTelegramAlert(msg); } catch (_) {}

    if (type === "read") rotateProvider(`quota-${Math.floor(usagePercent * 100)}`);
    else _rotateWrite();
  }
}

// ==================================================
// WRAP provider.send (with limiter + failover)
// ==================================================
function wrapProvider(p, url, type = "read") {
  const origSend = p.send.bind(p);
  p.send = async (...args) => {
    return safeRpcCall(async () => {
      try {
        await trackUsageAndRotate(url, type);
        return await origSend(...args);
      } catch (err) {
        const msg = `❌ ${type.toUpperCase()} RPC failed\n${url}\nError: ${err?.message || err}`;
        try { await sendTelegramAlert(msg); } catch (_) {}

        if (type === "read") return rotateProvider("dead-rpc").send(...args);
        return _rotateWrite().send(...args);
      }
    });
  };
  return p;
}

// ==================================================
// PROVIDER BUILD
// ==================================================
function buildProvider(url) {
  // In ethers v6, passing a Networkish pins the expected chainId (prevents mismatch surprises)
  return new ethers.JsonRpcProvider(url, NETWORKISH);
}

// ==================================================
// WRITE PROVIDERS
// ==================================================
let _wIdx = 0;
let _write = null;

function _buildWriteProvider(idx) {
  const url = WRITE_RPC_URLS[idx];
  const p = buildProvider(url);
  return wrapProvider(p, url, "write");
}

function _ensureWrite() {
  if (!_write) _write = _buildWriteProvider(_wIdx);
  return _write;
}

function _rotateWrite() {
  if (WRITE_RPC_URLS.length < 2) return _ensureWrite();
  const prev = WRITE_RPC_URLS[_wIdx];
  _wIdx = (_wIdx + 1) % WRITE_RPC_URLS.length;
  _write = _buildWriteProvider(_wIdx);
  const next = WRITE_RPC_URLS[_wIdx]; // fixed typo (was wIdx)
  try { sendTelegramAlert(`♻️ WRITE RPC rotated\nFrom: ${prev}\nTo: ${next}`); } catch (_) {}
  return _write;
}

export function getWriteProvider() {
  return _ensureWrite();
}

// ==================================================
// READ PROVIDERS
// ==================================================
let _rIdx = 0;
let _read = null;

function _buildReadProvider(idx) {
  const url = READ_RPC_URLS[idx];
  const p = buildProvider(url);
  return wrapProvider(p, url, "read");
}

function _ensureRead() {
  if (!_read) _read = _buildReadProvider(_rIdx);
  return _read;
}

export function rotateProvider(reason = "manual") {
  if (READ_RPC_URLS.length < 2) return _ensureRead();
  const prev = READ_RPC_URLS[_rIdx];
  _rIdx = (_rIdx + 1) % READ_RPC_URLS.length;
  _read = _buildReadProvider(_rIdx);
  const next = READ_RPC_URLS[_rIdx]; // fixed typo (was rIdx)
  try { sendTelegramAlert(`♻️ READ RPC rotated (${reason})\nFrom: ${prev}\nTo: ${next}`); } catch (_) {}
  return _read;
}

async function isHealthy(p, timeoutMs = READ_RPC_TIMEOUT_MS) {
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("timeout")), timeoutMs)
  );
  try {
    await Promise.race([
      safeRpcCall(() => p.getBlockNumber()),
      timeout
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function getReadProvider() {
  if (READ_RPC_URLS.length <= 1) return _ensureRead();

  const c0 = _ensureRead();
  const c1 = _buildReadProvider((_rIdx + 1) % READ_RPC_URLS.length);
  const c2 = _buildReadProvider((_rIdx + 2) % READ_RPC_URLS.length);

  const checks = await Promise.all(
    [c0, c1, c2].map((p) =>
      isHealthy(p) // fixed name (was _isHealthy)
        .then((ok) => ({ ok, p }))
        .catch(() => ({ ok: false, p }))
    )
  );

  const winner = checks.find((c) => c.ok)?.p;
  if (winner) return winner;

  return rotateProvider("dead-rpc");
}

export function getProvider() {
  return _ensureRead();
}

// ==================================================
// NETWORK SANITY
// ==================================================
export async function ensurePolygonNetwork(p = _ensureRead()) {
  const net = await safeRpcCall(() => p.getNetwork());
  const cid = normalizeChainId(net.chainId);
  if (cid !== CHAIN_ID) {
    throw new Error(`[dataprovider] Wrong chain: expected ${CHAIN_ID}, got ${cid}`);
  }
  return true;
}

export async function verifySameChain() {
  const readNet = await safeRpcCall(() => _ensureRead().getNetwork());
  const rId = normalizeChainId(readNet.chainId);
  if (rId !== CHAIN_ID) throw new Error(`Read provider chainId ${rId} != ${CHAIN_ID}`);

  const writeNet = await safeRpcCall(() => _ensureWrite().getNetwork());
  const wId = normalizeChainId(writeNet.chainId);
  if (wId !== CHAIN_ID) throw new Error(`Write provider chainId ${wId} != ${CHAIN_ID}`);

  return true;
}

export default {
  getProvider,
  getReadProvider,
  rotateProvider,
  ensurePolygonNetwork,
  getWriteProvider,
  verifySameChain,
};
