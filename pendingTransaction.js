// pendingTransaction.js
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import "dotenv/config";
import fetch from "node-fetch";
import { Worker } from "worker_threads";

// === Load router list ===
const routers = JSON.parse(fs.readFileSync("./routers.json", "utf8"));
const routerAddresses = Object.values(routers).map((r) => r.address.toLowerCase());
const routerMeta = Object.fromEntries(
  Object.entries(routers).map(([name, r]) => [r.address.toLowerCase(), { name: r.name, kind: r.kind }])
);

// === Worker setup ===
const WORKER_COUNT = 3;
const workers = [];
let nextWorker = 0;

for (let i = 0; i < WORKER_COUNT; i++) {
  const w = new Worker("./decoderWorker.js");
  workers.push(w);
}

// === Batch RPC request ===
const BATCH_SIZE = 50;
const rpcUrl = process.env.ALCHEMY_HTTPS;

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

// === PENDING TX Stream (Alchemy) ===
const wssUrl = process.env.ALCHEMY_WSS;
if (!wssUrl || !rpcUrl) throw new Error("❌ Missing RPC or WSS in .env");

let ws;
let txHashBuffer = [];
let isFlushing = false;

async function flushBatch() {
  if (isFlushing || !txHashBuffer.length) return;
  isFlushing = true;
  const batch = txHashBuffer.splice(0, BATCH_SIZE);

  try {
    const txs = await batchRequest(batch);
    const dexTxs = txs.filter((tx) => tx.to && routerAddresses.includes(tx.to.toLowerCase()));

    if (dexTxs.length > 0) {
      const worker = workers[nextWorker];
      nextWorker = (nextWorker + 1) % WORKER_COUNT;
      worker.postMessage(
        dexTxs.map((tx) => ({
          ...tx,
          routerKind: routerMeta[tx.to.toLowerCase()]?.kind || null,
        }))
      );
    }
  } finally {
    isFlushing = false;
  }
}

async function connect() {
  ws = new WebSocket(wssUrl);

  ws.on("open", () => {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params: ["newPendingTransactions"],
    }));
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.params && msg.params.result) {
      txHashBuffer.push(msg.params.result);
      if (txHashBuffer.length >= BATCH_SIZE) flushBatch();
    }
  });

  ws.on("close", () => setTimeout(connect, 2000));
}

connect();

// === LOCAL WS BROADCAST TO BACKRUNWATCHER ===
const server = http.createServer();
const localWss = new WebSocketServer({ server });
let clients = [];

localWss.on("connection", (client) => {
  clients.push(client);
  client.on("close", () => clients = clients.filter((c) => c !== client));
});

server.listen(7001, () =>
  console.log("✅ Forwarding decoded mempool tx on ws://127.0.0.1:7001")
);

// === Worker sends decoded transactions here ===
workers.forEach((worker) => {
  worker.on("message", (decodedBatch) => {
    decodedBatch.forEach((tx) => {
      const packet = {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        dexKind: tx.routerKind,
        method: tx.decoded?.method,
        tokenIn: tx.decoded?.tokenIn,
        tokenOut: tx.decoded?.tokenOut,
        amountIn: tx.decoded?.amountIn,
        amountOutMin: tx.decoded?.amountOutMin,
      };

      // ✅ forward ONLY decoded packet
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(packet));
        }
      });
    });
  });
});