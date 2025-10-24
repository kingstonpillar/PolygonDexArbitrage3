import { getReadProvider } from "./dataprovider.js";
import { ethers } from "ethers";

const CHAINLINK_FEEDS = {
  MATIC: "0xab594600376ec9fd91f8e885dadf0ce036862de0",
  POL:   "0xcD4722B7C08B20F93C2502b5B3433796bC5c8c57",
};

async function getNativePriceUSD(provider, symbol = "MATIC") {
  const feed = CHAINLINK_FEEDS[symbol.toUpperCase()];
  if (!feed) throw new Error(`Unsupported token symbol: ${symbol}`);

  try {
    const aggregator = new ethers.Contract(feed, ["function latestAnswer() view returns (int256)"], provider);
    const price = await aggregator.latestAnswer();
    return Number(ethers.formatUnits(price, 8)); // safer conversion
  } catch (e) {
    console.warn(`[GasHelper] Failed to fetch ${symbol} price:`, e.message);
    return symbol === "POL" ? 0.6 : 0.45;
  }
}

export async function getRealGasCostUSD(chainId = 137) {
  try {
    const provider = await getReadProvider(chainId, true); // WebSocket
    const gasPrice = await provider.getGasPrice();         // BigInt
    const gasUnits = 300_000;

    const gasToken = (process.env.GAS_TOKEN || "MATIC").toUpperCase();
    const gasCostNative = parseFloat(ethers.formatEther(gasPrice * BigInt(gasUnits))); // safe
    const nativePriceUSD = await getNativePriceUSD(provider, gasToken);
    const gasCostUSD = gasCostNative * nativePriceUSD;

    return { gasToken, gasCostNative, gasCostUSD };
  } catch (e) {
    console.warn("[GasHelper] failed to fetch gas:", e.message);
    return { gasToken: "UNKNOWN", gasCostNative: 0, gasCostUSD: 0 };
  }
}