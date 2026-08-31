import type { StallCategories, TradeDirection } from '@na/shared';
import { GREYBOX } from './greybox.js';

/**
 * stall の配置は config の stall_categories から計算する。
 * カテゴリが増減しても、ソースを直さずに並びが伸縮する。
 */

export interface StallSlot {
  categoryId: string;
  label_ja: string;
  direction: TradeDirection;
  sources_ja: string[];
  x: number;
  z: number;
  /** 通路（中央）を向く角度。 */
  rotationY: number;
}

export interface MarketLayout {
  slots: StallSlot[];
  halfWidth: number;
  halfDepth: number;
}

export function buildLayout(categories: StallCategories): MarketLayout {
  const { aisleWidth, marginZ, stallSpacing } = GREYBOX.space;
  const rows: { direction: TradeDirection; x: number; list: StallCategories['imports'] }[] = [
    { direction: 'import', x: -aisleWidth / 2, list: categories.imports },
    { direction: 'export', x: aisleWidth / 2, list: categories.exports },
  ];

  const longest = Math.max(categories.imports.length, categories.exports.length, 1);
  const halfDepth = ((longest - 1) * stallSpacing) / 2 + marginZ;
  // stall は通路を向いて置くので、幅方向に効くのは奥行きのほう。
  const halfWidth = aisleWidth / 2 + GREYBOX.stall.depth + marginZ * 0.4;

  const slots: StallSlot[] = [];
  for (const row of rows) {
    const span = (row.list.length - 1) * stallSpacing;
    row.list.forEach((category, index) => {
      slots.push({
        categoryId: category.id,
        label_ja: category.label_ja,
        direction: row.direction,
        sources_ja: category.sources_ja ?? [],
        x: row.x,
        z: -span / 2 + index * stallSpacing,
        rotationY: row.direction === 'import' ? Math.PI / 2 : -Math.PI / 2,
      });
    });
  }
  return { slots, halfWidth, halfDepth };
}
