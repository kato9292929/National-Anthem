import { createRng, hashString, type MarketItem, type StallCategory, type WorldConfig } from '@na/shared';
import type { MarketTuning } from './tuning.js';

/** 品目は config の stall_categories から生成する。ここに品目リテラルを書かない。 */
export function buildItems(config: WorldConfig, seed: number, tuning: MarketTuning): MarketItem[] {
  const from = (categories: StallCategory[], direction: 'import' | 'export'): MarketItem[] =>
    categories.map((category) => {
      // 品目ごとに独立した rng。カテゴリが増減しても他品目の値がずれない。
      const rng = createRng((seed ^ hashString(`${direction}:${category.id}`)) >>> 0);
      const t = tuning[direction];
      return {
        id: category.id,
        label_ja: category.label_ja,
        direction,
        sources_ja: category.sources_ja ?? [],
        basePrice: round2(rng.range(t.basePrice.min, t.basePrice.max)),
        targetStock: Math.round(rng.range(t.targetStock.min, t.targetStock.max)),
      };
    });

  return [
    ...from(config.stall_categories.imports, 'import'),
    ...from(config.stall_categories.exports, 'export'),
  ];
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
