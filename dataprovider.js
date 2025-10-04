// dataprovider.js — stabilized adaptive RPC manager (ethers v6)

import { POLYGON_CHAIN_ID, POLYGON_RPCS, WRITE_RPC_URL, READ_RPC_TIMEOUT_MS } from "./rpcConfig.js";
import { ethers } from "ethers";
import { sendTelegramAlert } from "./telegramalert.js";

// ==================================================
// CONSTANTS
// ==================================================
const MIN_CAP = 2;
const MAX_CAP = 8;
const MAX_QUEUE_SIZE = 800;

const QUOTAS = {
  alchemy: 100_000,
  infura: 3_000_000,
  getblock: 50_000,
  chainstack: 50_000,
  official: 100_000,
  default: 100_000,
};

const RPC_THRESHOLD = 0.8;
const MIN_SAMPLES_FOR_QUOTA = 300;

const FAST_METHODS = new Set(["eth_blockNumber", "eth_chainId", "net_version"]);

// ==================================================
// HELPERS
// ==================================================
function nowMs() { return Date.now(); }

function normalizeChainId(v) {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid POLYGON_CHAIN_ID: ${String(v)}`);
  }
  return n;
}

function ensureJsonRpcProvider(p, url) {
  if (!p || typeof p.send !== "function" || typeof p.getBlockNumber !== "function") {
    throw new Error(`Invalid provider for ${url}`);
  }
  return p;
}

// ==================================================
// NETWORK INIT
// ==================================================
const CHAIN_ID = normalizeChainId(POLYGON_CHAIN_ID);
const NETWORKISH = { name: "polygon", chainId: CHAIN_ID };

const _arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const READ_RPC_URLS = _arr(POLYGON_RPCS).filter((u) => typeof u === "string" && u.length > 0);
const WRITE_RPC_URLS = [WRITE_RPC_URL, ...READ_RPC_URLS].filter(Boolean);

if (READ_RPC_URLS.length === 0) throw new Error("POLYGON_RPCS is empty or invalid");

// ==================================================
// CONCURRENCY CONTROL (AIMD)
// ==================================================
let capacity = MIN_CAP;
let active = 0;
const fastWaiters = [];
const waiters = [];

const STATS_WINDOW = 100;
const TARGET_LAT_MS = 700;
let completed = 0;
let recentErrors = 0;
const lastLatencies = [];

function queueDepth() {
  return fastWaiters.length + waiters.length + Math.max(active - 0, 0);
}

function avgLatency() {
  if (lastLatencies.length === 0) return TARGET_LAT_MS;
  return lastLatencies.reduce((a, b) => a + b, 0) / lastLatencies.length;
}

function recordSample(lat, isError) {
  if (Number.isFinite(lat)) {
    lastLatencies.push(lat);
    if (lastLatencies.length > STATS_WINDOW) lastLatencies.shift();
  }
  if (isError) recentErrors++;
  completed++;
  if (completed >= STATS_WINDOW) {
    evaluateCapacity();
    completed = 0;
    recentErrors = 0;
  }
}

function evaluateCapacity() {
  const q = queueDepth();
  const avg = avgLatency();
  const errRate = recentErrors / STATS_WINDOW;

  if (errRate > 0.05 || avg > TARGET_LAT_MS * 2) {
    capacity = Math.max(MIN_CAP, Math.ceil(capacity / 2));
    return;
  }

  if (q > 0 && avg < TARGET_LAT_MS && errRate === 0) {
    capacity = Math.min(MAX_CAP, capacity + 1);
  }
}

async function safeRpcCall(fn, isFast = false) {
  if (fastWaiters.length + waiters.length >= MAX_QUEUE_SIZE) {
    throw new Error(`RPC queue overflow: >${MAX_QUEUE_SIZE} pending`);
  }

  if (active >= capacity) {
    await new Promise((resolve) => (isFast ? fastWaiters : waiters).push(resolve));
  }

  active++;
  const t0 = nowMs();
  let ok = false;
  try {
    const res = await fn();
    ok = true;
    return res;
  } catch (e) {
    recordSample(nowMs() - t0, true);
    throw e;
  } finally {
    if (ok) recordSample(nowMs() - t0, false);
    active--;
    const next = fastWaiters.length > 0 ? fastWaiters.shift() : waiters.shift();
    if (next) next();
  }
}

// ==================================================
// USAGE + ROTATION CONTROL
// ==================================================
const rpcUsage = {};
[...new Set([...WRITE_RPC_URLS, ...READ_RPC_URLS])].forEach((url) => (rpcUsage[url] = 0));

function detectType(url) {
  if (!url) return "default";
  const u = url.toLowerCase();
  if (u.includes("alchemy")) return "alchemy";
  if (u.includes("infura")) return "infura";
  if (u.includes("getblock")) return "getblock";
  if (u.includes("chainstack")) return "chainstack";
  if (u.includes("polygon-rpc")) return "official";
  return "default";
}

async function trackUsageAndMaybeRotate(url, type = "read") {
  const provType = detectType(url);
  const quota = QUOTAS[provType] ?? QUOTAS.default;
  rpcUsage[url] = (rpcUsage[url] || 0) + 1;
  const count = rpcUsage[url];
  const usagePercent = count / quota;
  if (count < MIN_SAMPLES_FOR_QUOTA) return;

  if (usagePercent >= RPC_THRESHOLD) {
    try {
      await sendTelegramAlert(
        `⚠️ ${type.toUpperCase()} RPC *${provType}* hit ${Math.floor(usagePercent * 100)}% quota\nRotating from:\n${url}`
      );
    } catch (_) {}
    if (type === "read") rotateProvider(`quota-${Math.floor(usagePercent * 100)}`);
    else _rotateWrite();
  }
}

// ==================================================
// PROVIDER BUILDERS
// ==================================================
function buildProvider(url) {
  return ensureJsonRpcProvider(new ethers.JsonRpcProvider(url, NETWORKISH), url);
}

function wrapProvider(p, url, type = "read", { noQuota = false } = {}) {
  const origSend = p.send.bind(p);

  p.send = async (method, params) => {
    const isFast = FAST_METHODS.has(method);
    const run = async () => {
      try {
        if (!noQuota) await trackUsageAndMaybeRotate(url, type);
        return await origSend(method, params);
      } catch (err) {
        const msg = String(err?.message || err);
        const isTimeout = /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|Network\s*Error/i.test(msg);

        if (type === "read" && isTimeout) {
          await new Promise((r) => setTimeout(r, 150));
          return origSend(method, params);
        }

        if (type === "read") return rotateProvider("dead-rpc").send(method, params);
        return _rotateWrite().send(method, params);
      }
    };
    return safeRpcCall(run, isFast);
  };
  return ensureJsonRpcProvider(p, url);
}

// ==================================================
// WRITE PROVIDER
// ==================================================
let _wIdx = 0;
let _write = null;

function _buildWriteProvider(idx) {
  const url = WRITE_RPC_URLS[idx];
  return wrapProvider(buildProvider(url), url, "write");
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
  const next = WRITE_RPC_URLS[_wIdx];
  try { sendTelegramAlert(`♻️ WRITE RPC rotated\nFrom: ${prev}\nTo: ${next}`); } catch (_) {}
  return _write;
}

export function getWriteProvider() { return _ensureWrite(); }

// ==================================================
// READ PROVIDER
// ==================================================
let _rIdx = 0;
let _read = null;

function _ensureRead() {
  if (!_read) _read = wrapProvider(buildProvider(READ_RPC_URLS[_rIdx]), READ_RPC_URLS[_rIdx], "read");
  return _read;
}

export async function rotateProvider(reason = "manual") {
  if (READ_RPC_URLS.length < 2) return _ensureRead();
  const prev = READ_RPC_URLS[_rIdx];
  _rIdx = (_rIdx + 1) % READ_RPC_URLS.length;
  _read = wrapProvider(buildProvider(READ_RPC_URLS[_rIdx]), READ_RPC_URLS[_rIdx], "read");
  const next = READ_RPC_URLS[_rIdx];
  try { sendTelegramAlert(`♻️ READ RPC rotated (${reason})\nFrom: ${prev}\nTo: ${next}`); } catch (_) {}
  return _read;
}

async function isHealthy(p, url) {
  try {
    const res = await Promise.race([
      p.getBlockNumber(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), Math.max(READ_RPC_TIMEOUT_MS || 0, 7000))
      )
    ]);
    return !!res;
  } catch {
    return false;
  }
}

export async function getReadProvider() {
  if (READ_RPC_URLS.length <= 1) return _ensureRead();

  const probes = [0, 1, 2].map((i) => READ_RPC_URLS[(i + _rIdx) % READ_RPC_URLS.length]);
  const checks = await Promise.all(
    probes.map(async (url) => {
      try {
        const ok = await isHealthy(buildProvider(url), url);
        return { url, ok };
      } catch { return { url, ok: false }; }
    })
  );

  const healthy = checks.find((c) => c.ok);
  if (healthy) {
    _read = wrapProvider(buildProvider(healthy.url), healthy.url, "read");
    return _read;
  }

  return rotateProvider("dead-rpc");
}

export function getProvider() { return _ensureRead(); }

// ==================================================
// NETWORK CHECKS
// ==================================================
export async function ensurePolygonNetwork(p = _ensureRead()) {
  const net = await safeRpcCall(() => p.getNetwork(), true);
  const cid = normalizeChainId(net.chainId);
  if (cid !== CHAIN_ID) throw new Error(`[dataprovider] Wrong chain: expected ${CHAIN_ID}, got ${cid}`);
  return true;
}

export async function verifySameChain() {
  const readNet = await safeRpcCall(() => _ensureRead().getNetwork(), true);
  const writeNet = await safeRpcCall(() => _ensureWrite().getNetwork(), true);
  const rId = normalizeChainId(readNet.chainId);
  const wId = normalizeChainId(writeNet.chainId);
  if (rId !== CHAIN_ID || wId !== CHAIN_ID)
    throw new Error(`Provider chain mismatch read=${rId} write=${wId}`);
  return true;
}

export default {
  getProvider,
  getReadProvider,
  getWriteProvider,
  rotateProvider,
  ensurePolygonNetwork,
  verifySameChain,
};