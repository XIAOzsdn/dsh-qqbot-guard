/**
 * 种子随机数：所有“随机选择”都必须由种子完全驱动。
 * 同一种子 + 同一输入 → 输出完全一致（可复现，无系统时钟参与选择）。
 */

/** FNV-1a 32 位字符串哈希 */
export function hashSeed(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用字符串种子创建随机引擎 */
export function createSeeded(seedText) {
  const next = mulberry32(hashSeed(seedText));
  return {
    next,
    /** [min,max) 的整数 */
    int(min, max) {
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      if (hi <= lo) return lo;
      return lo + Math.floor(next() * (hi - lo));
    },
    pick(list) {
      if (!Array.isArray(list) || list.length === 0) return undefined;
      return list[Math.floor(next() * list.length)];
    },
  };
}

/** 从列表里按种子挑一项（空列表返回 undefined） */
export function pickSeeded(list, seedText) {
  return createSeeded(seedText).pick(list);
}

/** 北京时间“今天”的标识，用于欢迎语按天固定 */
export function dayKeyUtc8(now = Date.now()) {
  const t = new Date(now + 8 * 3600_000);
  return t.toISOString().slice(0, 10);
}
