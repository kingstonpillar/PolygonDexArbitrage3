// broadcast_mock_or_real.js
// Tries to import your real broadcastPendingPool (broadcast.js).
// If not found, provides a realistic mock with dry-run/gas/timing behavior.

import { existsSync } from "fs";
import path from "path";
import { ethers } from "ethers";

const BROADCAST_PATH = path.join(process.cwd(), "broadcast.js");

export let broadcastPendingPool;

if (existsSync(BROADCAST_PATH)) {
  try {
    // require() style import to support both ESM/CJS depending on your environment
    const mod = await import(`file://${BROADCAST_PATH}`);
    if (mod && typeof mod.broadcastPendingPool === "function") {
      console.log("[mock-loader] Using real broadcastPendingPool from broadcast.js");
      broadcastPendingPool = mod.broadcastPendingPool;
    } else {
      console.warn("[mock-loader] broadcast.js found but export broadcastPendingPool not found. Falling back to mock.");
    }
  } catch (e) {
    console.warn("[mock-loader] Failed to import broadcast.js — using mock. Err:", e.message);
  }
}

if (!broadcastPendingPool) {
  // MOCK: simulate dry-run, gas estimation, RPC throttle, random success/failure
  broadcastPendingPool = async function mockBroadcast(pool) {
    const start = Date.now();
    // Respect env toggle for private RPC throttle simulation
    const THROTTLE_RATE = Number(process.env.MOCK_RPC_THROTTLE_RATE || 0); // e.g. 30 = 30% calls throttled
    const DRY_RUN_FAIL_RATE = Number(process.env.MOCK_DRYRUN_FAIL_RATE || 10); // % dry-run false

    // Simulated dry-run latency (ms)
    const dryRunTime = 30 + Math.floor(Math.random() * 80);
    await new Promise(r => setTimeout(r, dryRunTime));

    const dryOk = (Math.random() * 100) > DRY_RUN_FAIL_RATE;
    if (!dryOk) {
      console.log(`[mock-broadcast] dry-run FAILED for pool ${pool.id || "<id>"} (took ${Date.now()-start}ms)`);
      // we simulate the library behavior: continue (do not necessarily abort)
    } else {
      console.log(`[mock-broadcast] dry-run OK for pool ${pool.id || "<id>"} (took ${Date.now()-start}ms)`);
    }

    // simulate gas estimation latency
    const gasLatency = 20 + Math.floor(Math.random() * 60);
    await new Promise(r => setTimeout(r, gasLatency));

    // optionally throttle RPC sends (simulate private-relay 429 or rejection)
    const throttled = (Math.random() * 100) < THROTTLE_RATE;
    if (throttled) {
      console.warn(`[mock-broadcast] RPC throttled (simulated) for pool ${pool.id || "<id>"}`);
      return { status: "error", reason: "rpc_throttled", durationMs: Date.now() - start };
    }

    // simulate send latency + random success/fail
    const sendLatency = 40 + Math.floor(Math.random() * 120);
    await new Promise(r => setTimeout(r, sendLatency));

    const succeed = (Math.random() * 100) > 20; // 80% mock success
    if (!succeed) {
      console.warn(`[mock-broadcast] send failed for pool ${pool.id || "<id>"} (${Date.now()-start}ms)`);
      return { status: "fail", reason: "tx_send_failed", durationMs: Date.now() - start };
    }

    // build fake tx hash
    const fakeHash = "0x" + Buffer.from(String(Math.random())).toString("hex").slice(0, 60);
    console.log(`[mock-broadcast] sent (mock) ${fakeHash} for pool ${pool.id || "<id>"} (${Date.now()-start}ms)`);
    return { status: "submitted", txHash: fakeHash, durationMs: Date.now() - start };
  };
}

export default { broadcastPendingPool };