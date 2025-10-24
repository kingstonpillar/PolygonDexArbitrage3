// telegramalert.js — unified Telegram alert + trade emitter
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

// === ENV VARIABLES ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn(
    "[TelegramAlert] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env"
  );
}

// === BASE SENDER ===
async function sendTelegramMessage(message, silent = false) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "Markdown",
    disable_notification: silent,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn("[TelegramAlert] Telegram response error:", await res.text());
    }
  } catch (err) {
    console.error("[TelegramAlert] Send failed:", err.message);
  }
}

// === PUBLIC EXPORTS ===

// 🔔 Generic alerts (errors, warnings, skips, info)
export async function sendTelegram(text, silent = false) {
  await sendTelegramMessage(text, silent);
}

// 🚀 Trade event emitter (formatted summary for successful or failed executions)
export async function emitTradeAlert(trade) {
  try {
    const {
      pairSymbol,
      buyDex,
      sellDex,
      estProfitUSD,
      gasCostUSD,
      slippageUSD,
      txHash,
      status,
    } = trade;

    const emoji =
      status === "submitted"
        ? "✅"
        : status === "failed"
        ? "⚠️"
        : "📊";

    const msg = `
${emoji} *Trade Update*
• Pair: ${pairSymbol || "Unknown"}
• Buy from: ${buyDex}
• Sell to: ${sellDex}
• Est. Profit: ${estProfitUSD?.toFixed?.(2) || "?"} USD
• Gas: ${gasCostUSD?.toFixed?.(2) || "?"} USD
• Slippage: ${slippageUSD?.toFixed?.(2) || "?"} USD
• Status: ${status || "pending"}
${txHash ? `• Tx: [view](${txHash})` : ""}
`;

    await sendTelegramMessage(msg);
  } catch (e) {
    console.error("[emitTradeAlert] Failed:", e.message);
  }
}