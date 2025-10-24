// uniswapOracle.js — dynamic WMATIC/USD or POL/USD on Polygon
import { ethers } from "ethers";
import { getReadProvider } from "./dataprovider.js";

// Uniswap V3 Factory on Polygon
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"
];

const UNISWAP_V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

const TOKEN_ADDRESSES = {
  POL: "0x0000000000000000000000000000000000001010", // replace with official POL address
  WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
};
const FEE_TIER = 3000; // 0.3%

export async function getTokenUsdPrice(tokenSymbol = "WMATIC") {
  const provider = getReadProvider();
  const factory = new ethers.Contract(UNISWAP_V3_FACTORY, UNISWAP_V3_FACTORY_ABI, provider);
  const token = TOKEN_ADDRESSES[tokenSymbol.toUpperCase()];
  if (!token) throw new Error("Unknown token for oracle");

  try {
    const poolAddress = await factory.getPool(token, TOKEN_ADDRESSES.USDC, FEE_TIER);
    if (!poolAddress || poolAddress === ethers.ZeroAddress) {
      console.warn(`[UniswapOracle] No V3 pool found for ${tokenSymbol}/USDC`);
      return 0.4; // fallback
    }

    const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
    const [sqrtPriceX96] = await pool.slot0();
    const token0 = await pool.token0();
    const token1 = await pool.token1();

    // Determine decimals: USDC = 6, POL/WMATIC = 18
    let token0Decimals = token0.toLowerCase() === TOKEN_ADDRESSES.USDC.toLowerCase() ? 6 : 18;
    let token1Decimals = token1.toLowerCase() === TOKEN_ADDRESSES.USDC.toLowerCase() ? 6 : 18;

    const sqrtPriceX96Big = BigInt(sqrtPriceX96.toString());
    const price =
      Number(
        (sqrtPriceX96Big ** 2n * 10n ** BigInt(token1Decimals)) /
          (2n ** 192n * 10n ** BigInt(token0Decimals))
      );

    return price;
  } catch (err) {
    console.error(`[UniswapOracle] Failed for ${tokenSymbol}/USDC:`, err.message);
    return 0.4; // fallback
  }
}