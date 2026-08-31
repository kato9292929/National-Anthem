/**
 * 決定論の土台。同一シードなら同一の系列を返す。
 * Math.random は市場シムのどこでも使わない。
 */

/** FNV-1a 32bit。文字列から安定したシードを作る。 */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [min, max) */
  range(min: number, max: number): number;
  int(minInclusive: number, maxExclusive: number): number;
  /** p の確率で true。 */
  chance(p: number): boolean;
  /** 現在の内部状態。スナップショットと復元に使う。 */
  state(): number;
}

/** mulberry32。状態 32bit だけなので tick ごとの保存・復元が安い。 */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min)),
    chance: (p) => next() < p,
    state: () => s >>> 0,
  };
}

/** 文字列シードを 32bit に畳む。env の NA_MARKET_SEED はこれを通す。 */
export function seedFrom(input: string | number): number {
  if (typeof input === 'number') return input >>> 0;
  const asNumber = Number(input);
  if (Number.isFinite(asNumber) && input.trim() !== '') return asNumber >>> 0;
  return hashString(input);
}
