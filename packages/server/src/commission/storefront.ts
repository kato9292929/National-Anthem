import type { MarketItemState, WorldConfig } from '@na/shared';
import type { MarketSimulation } from '../market/simulation.js';
import type { EventLog } from '../store/event-log.js';

/**
 * 物販ストアフロント（副モジュール）。
 * 主モジュール（commission board）に従属する。ここから commission を触らない。
 * 価格・在庫は M1 の市場状態が正。クライアント側でも board 側でも持たない。
 *
 * 精算単位が未確定なので、金額は市場価格をそのまま最小単位の整数に丸めた値として扱い、
 * provisional を付けて回す。
 */

export class StorefrontError extends Error {
  override readonly name = 'StorefrontError';
}

export interface PurchaseReceipt {
  id: string;
  buyerId: string;
  itemId: string;
  quantity: number;
  /** 最小単位の整数文字列。単位は未確定。 */
  amount: string;
  unitPriceAtPurchase: number;
  at: number;
  provisional: true;
}

/** 値付けだけを固定した見積り（副作用なし）。決済フローはこの金額で回す。 */
export interface PurchaseQuote {
  itemId: string;
  label_ja: string;
  quantity: number;
  /** 最小単位の整数文字列。単位は未確定。 */
  amount: string;
  unitPrice: number;
}

export interface StorefrontOptions {
  world: WorldConfig;
  sim: MarketSimulation;
  log: EventLog;
  now?: () => number;
}

export class GoodsStorefront {
  /** 主モジュールへの従属を明示する。 */
  readonly rank = 'secondary' as const;
  readonly subordinateTo = 'commission-board' as const;

  private readonly now: () => number;
  private counter = 0;

  constructor(private readonly options: StorefrontOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 並ぶのは config の stall_categories 由来の品目だけ。 */
  listing(): { itemId: string; label_ja: string; direction: string; state: MarketItemState }[] {
    const state = this.options.sim.state(this.now());
    return state.items.map((item) => {
      const line = state.states.find((s) => s.itemId === item.id);
      if (!line) throw new StorefrontError(`市場状態が欠けている: ${item.id}`);
      return { itemId: item.id, label_ja: item.label_ja, direction: item.direction, state: line };
    });
  }

  /**
   * 値付けと在庫確認だけを行う（副作用なし・ログも残さない）。
   * 決済フローはこの金額で回す。設定した金額と受領した tx が食い違わないようにする。
   */
  quote(input: { itemId: string; quantity: number }): PurchaseQuote {
    if (input.quantity <= 0) throw new StorefrontError('数量は 1 以上');
    const state = this.options.sim.state(this.now());
    const item = state.items.find((i) => i.id === input.itemId);
    const line = state.states.find((s) => s.itemId === input.itemId);
    if (!item || !line) throw new StorefrontError(`config に無い品目: ${input.itemId}`);
    if (line.stock < input.quantity) {
      throw new StorefrontError(`在庫不足: ${input.itemId}（在庫 ${Math.floor(line.stock)} / 要求 ${input.quantity}）`);
    }
    return {
      itemId: item.id,
      label_ja: item.label_ja,
      quantity: input.quantity,
      amount: String(Math.round(line.price * input.quantity)),
      unitPrice: line.price,
    };
  }

  /** 決済が通った見積りを購入記録として残す。ログを残すのはここだけ。 */
  recordSettled(input: { buyerId: string; quote: PurchaseQuote }): PurchaseReceipt {
    this.counter += 1;
    const receipt: PurchaseReceipt = {
      id: `purchase-${String(this.counter).padStart(4, '0')}`,
      buyerId: input.buyerId,
      itemId: input.quote.itemId,
      quantity: input.quote.quantity,
      amount: input.quote.amount,
      unitPriceAtPurchase: input.quote.unitPrice,
      at: this.now(),
      provisional: true,
    };
    this.options.log.append('purchase', receipt, receipt.at);
    return receipt;
  }

  /** 決済なしの直接購入（従来経路・後方互換）。見積り → 記録を一息で行う。 */
  buy(input: { buyerId: string; itemId: string; quantity: number }): PurchaseReceipt {
    const quote = this.quote({ itemId: input.itemId, quantity: input.quantity });
    return this.recordSettled({ buyerId: input.buyerId, quote });
  }
}
