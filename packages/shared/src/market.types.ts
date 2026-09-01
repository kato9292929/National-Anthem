import type { TradeDirection } from './world-config.types.js';

/**
 * 市場の型はサーバとクライアントの契約。
 * クライアントは市場を持たない（描画するだけ）。
 */

export interface MarketItem {
  /** stall_categories の id をそのまま使う。品目は config から生成する。 */
  id: string;
  label_ja: string;
  direction: TradeDirection;
  sources_ja: string[];
  /** 生成時に決まる基準値。価格はここから乖離する。 */
  basePrice: number;
  targetStock: number;
}

export interface MarketItemState {
  itemId: string;
  price: number;
  stock: number;
  /** 直近 tick からの価格変化。HUD の上下表示に使う。 */
  priceDelta: number;
  /** 自分に直接かかっている供給ショック。無ければ null。 */
  shock: ActiveShock | null;
  /** 直撃と伝播を合わせた実効の供給倍率。1 なら平常。 */
  supplyMultiplier: number;
  /** 連関をたどって伝わってきた影響（仮の連関なので出所を残す）。 */
  propagation: PropagatedEffect[];
}

/** カテゴリ間の連関を伝わってきた供給への影響。 */
export interface PropagatedEffect {
  fromItemId: string;
  hops: number;
  /** 供給をどれだけ削るか（0..1）。 */
  effect: number;
}

/** 1 カテゴリを複数の stall が分け持つときの内訳。分布と値付けは仮値。 */
export interface MarketStallState {
  id: string;
  itemId: string;
  stock: number;
  price: number;
  /** 在庫・価格の分布は仮の設定に基づく。 */
  provisional: true;
}

export interface ActiveShock {
  id: string;
  itemId: string;
  /** 供給への倍率。1 未満で供給難（価格が上がる）。 */
  supplyMultiplier: number;
  startedTick: number;
  endsTick: number;
  /** 由来。scheduled = シードから決定論的に発生、manual = フック経由。 */
  origin: 'scheduled' | 'manual';
  note: string;
}

export interface MarketState {
  tick: number;
  /** シードは state に載せる。再現の照合に使う。 */
  seed: number;
  items: MarketItem[];
  states: MarketItemState[];
  shocks: ActiveShock[];
  /** stall ごとの内訳。カテゴリ単位の states が正で、こちらは分布。 */
  stalls: MarketStallState[];
  /** サーバ時刻（ms）。クライアントは補間に使わない（表示のみ）。 */
  updatedAt: number;
}

export interface MarketSnapshotLine {
  itemId: string;
  price: number;
  stock: number;
}

/** ヘッドレス実行と再現テストの照合に使う、tick ごとの最小形。 */
export interface MarketTrace {
  seed: number;
  ticks: { tick: number; lines: MarketSnapshotLine[] }[];
}
