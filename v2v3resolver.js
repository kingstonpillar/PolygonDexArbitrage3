// v2v3resolve.js
import { ethers } from 'ethers';
import { getReadProvider } from './dataprovider.js';

// Multicall3 contract (Polygon mainnet)
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// ABIs
const V2_ABI = ['function getReserves() view returns (uint112,uint112,uint32)'];
const V3_ABI = ['function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)'];

/**
 * Resolve reserves for Uniswap V2 & V3 style pools
 * @param {Array} pools - [{ dex, pairAddress, version }]
 * @returns {Array} [{ dex, pairAddress, reserve0, reserve1 }]
 */
export async function resolveV2V3Pairs(pools) {
  if (!pools || pools.length === 0) return [];

  // Use dataprovider for provider
  const provider = await getReadProvider();

  const multicallAbi = [
    'function aggregate((address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)'
  ];
  const multicall = new ethers.Contract(MULTICALL3, multicallAbi, provider);

  const v2iface = new ethers.Interface(V2_ABI);
  const v3iface = new ethers.Interface(V3_ABI);

  // Prepare multicall batch
  const calls = pools.map(p => {
    const iface = p.version === 'v3' ? v3iface : v2iface;
    const fn = p.version === 'v3' ? 'slot0' : 'getReserves';
    return {
      target: p.pairAddress,
      callData: iface.encodeFunctionData(fn)
    };
  });

  try {
    const [, returnData] = await multicall.aggregate(calls);
    const results = [];

    for (let i = 0; i < returnData.length; i++) {
      const p = pools[i];
      const iface = p.version === 'v3' ? v3iface : v2iface;
      try {
        if (p.version === 'v3') {
          const [sqrtPriceX96] = iface.decodeFunctionResult('slot0', returnData[i]);
          const price = Number(sqrtPriceX96) / 2 ** 96; // approximate ratio
          results.push({
            dex: p.dex,
            pairAddress: p.pairAddress,
            reserve0: price,
            reserve1: 1
          });
        } else {
          const [r0, r1] = iface.decodeFunctionResult('getReserves', returnData[i]);
          results.push({
            dex: p.dex,
            pairAddress: p.pairAddress,
            reserve0: Number(r0),
            reserve1: Number(r1)
          });
        }
      } catch {
        results.push({
          dex: p.dex,
          pairAddress: p.pairAddress,
          reserve0: 0,
          reserve1: 0
        });
      }
    }

    return results;
  } catch (err) {
    console.error('[v2v3resolve] multicall failed:', err.message);
    return [];
  }
}