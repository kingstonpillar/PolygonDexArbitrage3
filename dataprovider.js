// dataprovider.js — Ethers v6, stable rotation, limiter, quota-aware

import { ethers } from "ethers";
import {
  POLYGON_CHAIN_ID,
  POLYGON_RPCS,
  WRITE_RPC_URL,
  READ_RPC_TIMEOUT_MS,
} from "./rpcConfig.js";
import { sendTelegramAlert } from "./telegramalert.js";

// ==================================================
// CONFIG
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

const CHAIN_ID = Number(POLYGON_CHAIN_ID);
const NETWORKISH = { name: "polygon", chainId: CHAIN_ID };

// ==================================================
// BASIC HELPERS
// ==================================================
const _arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const READ_RPC_URLS = _arr(POLYGON_RPCS).filter(Boolean);
const WRITE_RPC_URLS = [WRITE_RPC_URL, ...READ_RPC_URLS].filter(Boolean);

if (READ_RPC_URLS.length === 0) throw new Error("POLYGON_RPCS is empty");

// ==================================================
// ADAPTIVE CONCURRENCY LIMITER
// ==================================================
let capacity = MIN_CAP;
let active = 0;
const fastWaiters = [];
const waiters = [];
const lastLatencies = [];
const STATS_WINDOW = 100;
const TARGET_LAT_MS = 700;
let completed = 0;
let recentErrors = 0;

function nowMs() { return Date.now(); }
function queueDepth() { return fastWaiters.length + waiters.length + Math.max(active, 0); }
function avgLatency() {
  if (!lastLatencies.length) return TARGET_LAT_MS;
  return lastLatencies.reduce((a, b) => a + b, 0) / lastLatencies.length;
}

function recordSample(lat, isError) {
  if (Number.isFinite(lat)) lastLatencies.push(lat);
  if (lastLatencies.length > STATS_WINDOW) lastLatencies.shift();
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
  if (fastWaiters.length + waiters.length >= MAX_QUEUE_SIZE)
    throw new Error("RPC queue overflow");
  if (active >= capacity)
    await new Promise((resolve) => (isFast ? fastWaiters : waiters).push(resolve));
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
    const next = fastWaiters.length ? fastWaiters.shift() : waiters.shift();
    if (next) next();
  }
}

// ==================================================
// RPC USAGE TRACKER
// ==================================================
const rpcUsage = {};
[...new Set([...WRITE_RPC_URLS, ...READ_RPC_URLS])].forEach(
  (url) => (rpcUsage[url] = 0)
);

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
        `⚠️ ${type.toUpperCase()} RPC *${provType}* hit ${Math.floor(
          usagePercent * 100
        )}% quota\nRotating from: ${url}`
      );
    } catch (_) {}
    if (type === "read") rotateProvider(`quota-${Math.floor(usagePercent * 100)}`);
    else _rotateWrite();
  }
}

// ==================================================
// PROVIDER WRAPPER (keeps Ethers v6 prototype)
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

        const isTimeout = /timeout|ECONNRESET|EAI_AGAIN|Network/i.test(
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

  // preserve ethers v6 prototype
  Object.setPrototypeOf(p, ethers.JsonRpcProvider.prototype);
  return p;
}

function buildProvider(url) {
  return new ethers.JsonRpcProvider(url, NETWORKISH);
}

function buildWrappedRead(idx) {
  const url = READ_RPC_URLS[idx];
  return wrapProvider(buildProvider(url), url, "read");
}

function buildPlainRead(idx) {
  return buildProvider(READ_RPC_URLS[idx]);
}

// ==================================================
// WRITE PROVIDERS
// ==================================================
let _wIdx = 0;
let _write = null;

function _buildWriteProvider(idx) {
  return wrapProvider(buildProvider(WRITE_RPC_URLS[idx]), WRITE_RPC_URLS[idx], "write");
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
  try {
    sendTelegramAlert(`♻️ WRITE RPC rotated\nFrom: ${prev}\nTo: ${next}`);
  } catch (_) {}
  return _write;
}

// ==================================================
// READ PROVIDERS
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
  try {
    sendTelegramAlert(`♻️ READ RPC rotated (${reason})\nFrom: ${prev}\nTo: ${next}`);
  } catch (_) {}
  return _read;
}

// ==================================================
// HEALTH CHECK + GET PROVIDERS
// ==================================================
async function isHealthy(p) {
  try {
    const res = await Promise.race([
      p.getBlockNumber(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), Math.max(READ_RPC_TIMEOUT_MS || 0, 7000))
      ),
    ]);
    return !!res;
  } catch {
    return false;
  }
}

export async function getReadProvider() {
  if (READ_RPC_URLS.length <= 1) return _ensureRead();

  const probes = [
    buildPlainRead(_rIdx),
    buildPlainRead((_rIdx + 1) % READ_RPC_URLS.length),
    buildPlainRead((_rIdx + 2) % READ_RPC_URLS.length),
  ];

  const checks = await Promise.all(
    probes.map((p) =>
      isHealthy(p).then((ok) => ({ ok, p })).catch(() => ({ ok: false, p }))
    )
  );

  const winner = checks.find((c) => c.ok)?.p;
  if (winner) {
    const idxs = [_rIdx, (_rIdx + 1) % READ_RPC_URLS.length, (_rIdx + 2) % READ_RPC_URLS.length];
    const winIdx = probes.findIndex((p) => p === winner);
    if (winIdx !== -1 && idxs[winIdx] !== _rIdx) {
      _rIdx = idxs[winIdx];
      _read = buildWrappedRead(_rIdx);
    }
    return _ensureRead();
  }

  return rotateProvider("dead-rpc");
}

export function getProvider() {
  return _ensureRead();
}

export function getWriteProvider() {
  return _ensureWrite();
}

export async function ensurePolygonNetwork(p = _ensureRead()) {
  const net = await safeRpcCall(() => p.getNetwork(), true);
  if (Number(net.chainId) !== Number(CHAIN_ID)) {
    throw new Error(`[dataprovider] Wrong chain: expected ${CHAIN_ID}, got ${net.chainId}`);
  }
  return true;
}

export async function verifySameChain() {
  const rId = Number((await _ensureRead().getNetwork()).chainId);
  const wId = Number((await _ensureWrite().getNetwork()).chainId);
  if (rId !== Number(CHAIN_ID)) throw new Error(`Read provider chainId ${rId} != ${CHAIN_ID}`);
  if (wId !== Number(CHAIN_ID)) throw new Error(`Write provider chainId ${wId} != ${CHAIN_ID}`);
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