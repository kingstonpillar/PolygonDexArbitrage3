import { ethers } from 'ethers';
import { getReadProvider } from './dataprovider.js';

async function promiseWithTimeout(promise, ms = 3000, fallback = [ethers.Zero, ethers.Zero]) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => (timer = setTimeout(() => resolve(fallback), ms)))
  ]).finally(() => clearTimeout(timer));
}

const cache = new Map();
function setCache(key, value, ttl = 200) {
  cache.set(key, { value, expire: Date.now() + ttl });
}
function getCache(key) {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expire) return entry.value;
  cache.delete(key);
  return null;
}

export async function getKyberElasticReserves(pools) {
  const provider = await getReadProvider();
  const ABI = ['function getReserves() view returns (uint112,uint112,uint32)'];

  const results = await Promise.all(
    pools.map(async (p) => {
      const cacheKey = `kyber:${p.pairAddress}`;
      const cached = getCache(cacheKey);
      if (cached) return cached;

      try {
        const contract = new ethers.Contract(p.pairAddress, ABI, provider);
        const [r0, r1] = await promiseWithTimeout(contract.getReserves(), 3000, [ethers.Zero, ethers.Zero]);

        const resObj = {
          dex: p.dex,
          pairAddress: p.pairAddress,
          reserve0: parseFloat(ethers.formatUnits(r0, 18)),
          reserve1: parseFloat(ethers.formatUnits(r1, 18))
        };
        setCache(cacheKey, resObj);
        return resObj;
      } catch (err) {
        const resObj = { dex: p.dex, pairAddress: p.pairAddress, reserve0: 0, reserve1: 0 };
        setCache(cacheKey, resObj);
        return resObj;
      }
    })
  );

  return results;
}