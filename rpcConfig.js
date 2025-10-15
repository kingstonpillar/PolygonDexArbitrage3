import 'dotenv/config';

// Polygon chain ID
export const POLYGON_CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// Write & read provider URL (single Alchemy RPC)
export const WRITE_RPC_URL = process.env.WRITE_RPC_URL?.trim();

if (!WRITE_RPC_URL) {
  throw new Error(
    "[rpcConfig] WRITE_RPC_URL not set in .env! Please add your Alchemy RPC URL."
  );
}

export default {
  POLYGON_CHAIN_ID,
  WRITE_RPC_URL,
};