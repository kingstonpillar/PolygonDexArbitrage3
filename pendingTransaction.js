// pendingTransaction.js
import http from "http";
import WebSocket from "ws";
import fs from "fs";
import "dotenv/config";
import fetch from "node-fetch";
import { Worker } from "worker_threads";

// === Load router list ===
const routers = JSON.parse(fs.readFileSync("./routers.json", "utf8"));
const routerAddresses = Object.values(routers).map((r) => r.address.toLowerCase());
const routerMeta = Object.fromEntries(
  Object.entries(routers).map(([name, r]) => [r.address.toLowerCase(), { name, kind: r.kind }])
);

// === Telegram alert ===
async function sendTelegramAlert(msg) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🚨 [pendingTransaction]\n${msg}`,
      }),
    });
  } catch (err) {
    console.error("⚠️ Telegram alert failed:", err.message);
  }
}

// === Worker setup (3 workers for decoding) ===
const WORKER_COUNT = 3;
const workers = [];
let nextWorker = 0;

for (let i = 0; i < WORKER_COUNT; i++) {
  const w = new Worker("./decoderWorker.js");
  w.on("error", (err) => console.error(`Worker ${i} error:`, err.message));
  w.on("exit", (code) => console.warn(`Worker ${i} exited with code ${code}`));
  workers.push(w);
}

// === Main generator ===
export async function* txStream() {
  const wssUrl = process.env.ALCHEMY_WSS;
  const rpcUrl = process.env.ALCHEMY_HTTPS;
  if (!wssUrl || !rpcUrl) throw new Error("❌ Missing ALCHEMY_WSS or ALCHEMY_HTTPS in .env");

  const pending = [];
  let ws;
  let heartbeat;
  let reconnectDelay = 1000;
  let txCount = 0;

  // === Heartbeat keepalive ===
  const startHeartbeat = () => {
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20000);
  };

  // === Batching logic ===
  const BATCH_SIZE = 50;
  const BATCH_INTERVAL = 100;
  let txHashBuffer = [];
  let lastBatchTime = Date.now();

  async function batchRequest(txHashes) {
    const payload = txHashes.map((h, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "eth_getTransactionByHash",
      params: [h],
    }));

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await res.json();
    return json.map((r) => r.result).filter(Boolean);
  }

  async function flushBatch() {
    if (!txHashBuffer.length) return;
    const batch = txHashBuffer.splice(0, BATCH_SIZE);
    try {
      const results = await batchRequest(batch);
      const filtered = results
        .filter((tx) => tx && tx.to && routerAddresses.includes(tx.to.toLowerCase()))
        .map((tx) => ({
          ...tx,
          routerKind: routerMeta[tx.to.toLowerCase()]?.kind || null,
        }));

      if (filtered.length) {
        const worker = workers[nextWorker];
        nextWorker = (nextWorker + 1) % WORKER_COUNT;
        worker.postMessage(filtered);
      }
    } catch (err) {
      console.error("Batch fetch failed:", err.message);
    }
  }



  // === Connection logic ===
  const connect = () => {
    return new Promise((resolve) => {
      ws = new WebSocket(wssUrl);

      ws.on("open", async () => {
        console.log("✅ Connected to Alchemy pending tx stream...");
        await sendTelegramAlert("✅ Connected to Alchemy pending tx stream");
        reconnectDelay = 1000;
        startHeartbeat();

        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: ["newPendingTransactions"],
          })
        );
        resolve();
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.params && msg.params.result) {
            const txHash = msg.params.result;
            txHashBuffer.push(txHash);
            if (txHashBuffer.length >= BATCH_SIZE) flushBatch();
          }
        } catch (err) {
          console.error("⚠️ Error processing message:", err.message);
        }
      });

      ws.on("close", async () => {
        console.warn("⚠️ WebSocket closed — reconnecting...");
        clearInterval(heartbeat);
        await sendTelegramAlert("⚠️ WebSocket closed — reconnecting...");
        reconnect();
      });

      ws.on("error", async (err) => {
        console.warn("⚠️ WebSocket error:", err.message);
        await sendTelegramAlert(`⚠️ WebSocket error: ${err.message}`);
        ws.close();
      });
    });
  };

  // === Reconnect logic ===
  const reconnect = async () => {
    console.log(`🔁 Reconnecting in ${(reconnectDelay / 1000).toFixed(1)}s...`);
    await new Promise((r) => setTimeout(r, reconnectDelay));
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    try {
      await connect();
      await sendTelegramAlert("✅ Successfully reconnected to Alchemy stream");
    } catch (err) {
      console.error("❌ Reconnect failed:", err.message);
      await sendTelegramAlert(`❌ Reconnect failed: ${err.message}`);
      reconnect();
    }
  };

  await connect();

  // === Yield loop ===
  for (;;) {
    if (pending.length) yield pending.shift();
    await new Promise((r) => setTimeout(r, 50));
  }
}
const server = http.createServer();
const localWss = new WebSocket.Server({ server });

let clients = [];

localWss.on("connection", (ws) => {
  clients.push(ws);
  ws.on("close", () => {
    clients = clients.filter((c) => c !== ws);
  });
});

server.listen(7001, () => {
  console.log("🌐 Local TX feed server started on ws://127.0.0.1:7001");
});

// Broadcast decoded TXs to connected modules
for (const worker of workers) {
  worker.on("message", (decodedBatch) => {
    for (const tx of decodedBatch) {
      if (!tx) continue;

      const decoded = tx.decoded || {};
      const packet = {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        dexKind: tx.routerKind || decoded.dexKind || null,
        method: decoded.method || null,
        tokenIn: decoded.tokenIn || null,
        tokenOut: decoded.tokenOut || null,
        amountIn: decoded.amountIn || null,
        amountOutMin: decoded.amountOutMin || null,
        priceEst: decoded.priceEst || 0,
      };

      // Broadcast over local WebSocket
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(packet));
        }
      }
    }
  });
}