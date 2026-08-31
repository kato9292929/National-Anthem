/**
 * 市場の数値は v0 で未確定。ここに置く値はすべて【仮値】。
 * 確定した経済仕様が来たら、この 1 ファイルの差し替えで済む形にしておく。
 * commission_flow（レグ数・遠隔地の扱い・精算単位）が確定するまで、ここは仮のまま。
 */
export interface MarketTuning {
  /** 輸入品（南部に無い資源）: 高値・薄い在庫・遅い補充。world-spec §2。 */
  import: DirectionTuning;
  /** 輸出品（南部の生産物）: 安値・厚い在庫・速い補充。 */
  export: DirectionTuning;
  /** 在庫が目標を割ったときに補充が増える強さ（平均回帰）。 */
  restockResponse: number;
  /** 価格が基準を超えたときに消費が減る強さ（平均回帰）。 */
  demandElasticity: number;
  /** 価格が目標値へ寄る速さ（0..1）。 */
  priceSmoothing: number;
  /** 在庫比 1 からの乖離が価格に効く強さ。 */
  priceElasticity: number;
  /** 基準価格に対する価格の下限・上限。 */
  priceFloorRatio: number;
  priceCeilRatio: number;
  /** 1 tick あたりに供給ショックが起きる確率（品目ごと）。 */
  shockChancePerTick: number;
  shockDurationTicks: { min: number; max: number };
  shockSupplyMultiplier: { min: number; max: number };
}

export interface DirectionTuning {
  basePrice: { min: number; max: number };
  targetStock: { min: number; max: number };
  /** 1 tick に動く量（targetStock に対する比）。補充と消費はここから振り分ける。 */
  throughputRate: { min: number; max: number };
  /** 補充側の偏り（throughput に対する倍率）。 */
  restockBias: { min: number; max: number };
  /** 消費側の偏り（throughput に対する倍率）。 */
  demandBias: { min: number; max: number };
  /** 消費のゆらぎ幅。 */
  demandJitter: number;
}

/** 【仮値】v0 の経済仕様が確定するまでの既定。 */
export const DEFAULT_TUNING: MarketTuning = {
  import: {
    basePrice: { min: 120, max: 260 },
    targetStock: { min: 24, max: 64 },
    throughputRate: { min: 0.03, max: 0.07 },
    restockBias: { min: 0.9, max: 1.05 },
    demandBias: { min: 0.95, max: 1.1 },
    demandJitter: 0.5,
  },
  export: {
    basePrice: { min: 18, max: 72 },
    targetStock: { min: 90, max: 220 },
    throughputRate: { min: 0.06, max: 0.12 },
    restockBias: { min: 0.95, max: 1.1 },
    demandBias: { min: 0.9, max: 1.05 },
    demandJitter: 0.35,
  },
  restockResponse: 0.9,
  demandElasticity: 0.8,
  priceSmoothing: 0.25,
  priceElasticity: 0.55,
  priceFloorRatio: 0.35,
  priceCeilRatio: 3.5,
  shockChancePerTick: 0.01,
  shockDurationTicks: { min: 8, max: 24 },
  shockSupplyMultiplier: { min: 0.15, max: 0.6 },
};

/** README の未確定リストに出す用。 */
export const TUNING_PROVISIONAL_NOTE =
  '市場の数値（基準価格・在庫・補充・消費・ショック）はすべて仮値。v0 の経済仕様確定で差し替える。';
