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
  /** 進行中の供給ショック。無ければ null。 */
  shock: ActiveShock | null;
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
