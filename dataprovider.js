// dataprovider.js — adaptive limiter (2→8), fast-lane, safe health-checks, retry-on-timeout, strict network (ethers v6)

import { POLYGON_CHAIN_ID, POLYGON_RPCS, WRITE_RPC_URL, READ_RPC_TIMEOUT_MS } from "./rpcConfig.js";
import { ethers } from "ethers";
import { sendTelegramAlert } from "./telegramalert.js";

// ==================================================
// CORE CONSTANTS
// ==================================================

// Adaptive concurrency (AIMD)
const MIN_CAP = 2;
const MAX_CAP = 8;

// Queue sizing
const MAX_QUEUE_SIZE = 800;

// Quotas + rotation hysteresis
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

// Methods that should never be starved (fast lane)
const FAST_METHODS = new Set(["eth_blockNumber", "eth_chainId", "net_version"]);

// Network pinning
function normalizeChainId(v) {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid POLYGON_CHAIN_ID: ${String(v)}`);
  }
  return n;
}
const CHAIN_ID = normalizeChainId(POLYGON_CHAIN_ID);
const NETWORKISH = { name: "polygon", chainId: CHAIN_ID };

// ==================================================
// INPUT SANITY
// ==================================================
const _arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const READ_RPC_URLS = _arr(POLYGON_RPCS).filter((u) => typeof u === "string" && u.length > 0);
const WRITE_RPC_URLS = [WRITE_RPC_URL, ...READ_RPC_URLS].filter(Boolean);
if (READ_RPC_URLS.length === 0) throw new Error("POLYGON_RPCS is empty or invalid");

// ==================================================
// ADAPTIVE CONCURRENCY (AIMD)
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

function nowMs() { return Date.now(); }

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
// USAGE TRACKING + ROTATION
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
// WRAP PROVIDER
// ==================================================
function wrapProvider(p, url, type = "read", { noQuota = false } = {}) {
  const origSend = p.send.bind(p);

  p.send = async (method, params) => {
    const isFast = FAST_METHODS.has(method);

    const run = async () => {
      try {
        if (!noQuota) await trackUsageAndMaybeRotate(url, type);
        return await origSend(method, params);
      } catch (err) {
        try {
          await sendTelegramAlert(
            `❌ ${type.toUpperCase()} RPC failed\n${url}\nMethod: ${method}\nError: ${err?.message || err}`
          );
        } catch (_) {}

        const isTimeout = /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|Network\s*Error/i.test(
          String(err?.message || err)
        );
        if (type === "read" && isTimeout && queueDepth() > 0) {
          await new Promise((r) => setTimeout(r, 150));
          try {
            return await origSend(method, params);
          } catch (_) {}
        }

        if (type === "read") return rotateProvider("dead-rpc").send(method, params);
        return _rotateWrite().send(method, params);
      }
    };

    return safeRpcCall(run, isFast);
  };

  return p;
}

// ==================================================
// PROVIDER BUILDERS
// ==================================================
function buildProvider(url) {
  return new ethers.JsonRpcProvider(url, NETWORKISH);
}

function buildWrappedRead(idx) {
  const url = READ_RPC_URLS[idx];
  return wrapProvider(buildProvider(url), url, "read");
}

function buildPlainRead(idx) {
  const url = READ_RPC_URLS[idx];
  return buildProvider(url);
}

// ==================================================
// WRITE PROVIDERS
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

export function getWriteProvider() {
  return _ensureWrite();
}

// ==================================================
// READ PROVIDERS (GLOBAL ROTATION)
// ==================================================
let _rIdx = 0;
let _read = null;

function _ensureRead() {
  if (!_read) _read = buildWrappedRead(_rIdx);
  return _read;
}

export async function rotateProvider(reason = "manual") {
  if (READ_RPC_URLS.length < 2) return _ensureRead();
  const prev = READ_RPC_URLS[_rIdx];
  _rIdx = (_rIdx + 1) % READ_RPC_URLS.length;
  _read = buildWrappedRead(_rIdx);
  const next = READ_RPC_URLS[_rIdx];
  try { sendTelegramAlert(`♻️ READ RPC rotated (${reason})\nFrom: ${prev}\nTo: ${next}`); } catch (_) {}
  return _read;
}

// Health check (PLAIN provider + tolerant timeout)
async function isHealthy(p) {
  try {
    const res = await Promise.race([
      // plain provider call (no limiter/quota)
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

// ==================================================
// MAIN READ PROVIDER
// ==================================================
export async function getReadProvider() {
  if (READ_RPC_URLS.length <= 1) return _ensureRead();

  // use PLAIN providers for all probes to avoid queue-induced false negatives
  const c0 = buildPlainRead(_rIdx);
  const c1 = buildPlainRead((_rIdx + 1) % READ_RPC_URLS.length);
  const c2 = buildPlainRead((_rIdx + 2) % READ_RPC_URLS.length);

  const checks = await Promise.all(
    [c0, c1, c2].map((p) =>
      isHealthy(p).then((ok) => ({ ok, p })).catch(() => ({ ok: false, p }))
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
  const net = await safeRpcCall(() => p.getNetwork(), true);
  const cid = normalizeChainId(net.chainId);
  if (cid !== CHAIN_ID) {
    throw new Error(`[dataprovider] Wrong chain: expected ${CHAIN_ID}, got ${cid}`);
  }
  return true;
}

export async function verifySameChain() {
  const readNet = await safeRpcCall(() => _ensureRead().getNetwork(), true);
  const rId = normalizeChainId(readNet.chainId);
  if (rId !== CHAIN_ID) throw new Error(`Read provider chainId ${rId} != ${CHAIN_ID}`);

  const writeNet = await safeRpcCall(() => _ensureWrite().getNetwork(), true);
  const wId = normalizeChainId(writeNet.chainId);
  if (wId !== CHAIN_ID) throw new Error(`Write provider chainId ${wId} != ${CHAIN_ID}`);

  return true;
}

// ==================================================
// DEFAULT EXPORT
// ==================================================
export default {
  getProvider,
  getReadProvider,
  rotateProvider,
  ensurePolygonNetwork,
  getWriteProvider,
  verifySameChain,
};
