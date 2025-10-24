import { ethers, BigNumber } from "ethers";
import { getTokenUsdPrice } from "../uniswapOracle.js";

let _tokenPrices = {};
let _lastUpdate = {}; // per token

function bnToFloat(amount, decimals = 18) {
  if (BigNumber.isBigNumber(amount)) return parseFloat(ethers.formatUnits(amount, decimals));
  return parseFloat(amount); // fallback
}

export async function calcLiquidityUSD(reserveAmount, tokenAddress, priceMap = {}) {
  const HUB_TOKENS = [
    process.env.HUB_TOKEN_1 || "0x2791Bca1f2de4661ED88A30C99A7a944aA84174",
    process.env.HUB_TOKEN_2 || "0xc2132D05D31c914a87C6611C10748AaCB4FE7392",
    process.env.HUB_TOKEN_3 || "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    process.env.HUB_TOKEN_4 || "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
    process.env.HUB_TOKEN_5 || "0x0000000000000000000000000000000000001010"  // POL
  ].map(t => t.toLowerCase());

  const addr = tokenAddress.toLowerCase();

  // Stable tokens (6 decimals)
  if (HUB_TOKENS.slice(0, 3).includes(addr)) return bnToFloat(reserveAmount, 6);

  // WMATIC or POL
  if ([HUB_TOKENS[3], HUB_TOKENS[4]].includes(addr)) {
    const symbol = addr === HUB_TOKENS[3] ? "WMATIC" : "POL";
    const price = await getLiveTokenPrice(symbol);
    return bnToFloat(reserveAmount, 18) * price;
  }

  // Volatile tokens
  if (priceMap[addr]) return bnToFloat(reserveAmount, 18) * priceMap[addr];

  // Fallback
  const fallbackPrice = await getLiveTokenPrice("WMATIC");
  return bnToFloat(reserveAmount, 18) * fallbackPrice;
}