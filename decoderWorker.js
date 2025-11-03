// decoderWorker.js
import { parentPort } from "worker_threads";
import { decodeSwapForRouter } from "./decoder.js"; // your ABI decoder

parentPort.on("message", (batch) => {
  const results = [];
  for (const tx of batch) {
    try {
      const decoded = decodeSwapForRouter(tx, tx.routerKind);
      results.push({ ...tx, decoded });
    } catch (e) {
      results.push({ ...tx, decoded: null, error: e.message });
    }
  }
  parentPort.postMessage(results);
});