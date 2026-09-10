import type { CommissionConfig } from '@na/shared';
import { MemoryEventLog, type EventLog } from './event-log.js';

/**
 * 買い手の手持ち（inventory / credits）。物販デモ（副モジュール・区分A mock）用。
 *
 * - 状態は決済が settle まで通ったときにだけ動く。402 を受けただけ・署名しただけでは動かさない。
 * - イベントから作り直す（identity と同じ event-sourced）。再起動しても続く。
 * - 初期 credits と容量は config 由来（commission.config.json の storefront）。ここにリテラルを持たない。
 * - 精算単位が未確定なので credits も amount も最小単位の整数として扱う（provisional）。
 */

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
}

export interface LedgerState {
  buyerId: string;
  credits: number;
  inventory: { itemId: string; quantity: number }[];
  /** 手持ちの総数（容量判定に使う）。 */
  held: number;
  capacity: number;
  startingCredits: number;
  purchases: number;
  /** 初期 credits・容量が未確定であることを示す。 */
  provisional: boolean;
}

interface LedgerPurchasePayload {
  buyerId: string;
  itemId: string;
  quantity: number;
  /** 最小単位の整数文字列。 */
  amount: string;
  at: number;
}

interface Holdings {
  credits: number;
  inventory: Map<string, number>;
  purchases: number;
}

export interface PlayerLedgerOptions {
  config: CommissionConfig['storefront'];
  log?: EventLog;
  now?: () => number;
}

export class PlayerLedger {
  private readonly holdings = new Map<string, Holdings>();
  private readonly startingCredits: number;
  private readonly capacity: number;
  private readonly provisional: boolean;
  private readonly now: () => number;
  private readonly log: EventLog;

  constructor(options: PlayerLedgerOptions) {
    this.startingCredits = options.config.startingCredits;
    this.capacity = options.config.inventoryCapacity;
    this.provisional = !options.config.confirmed;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? new MemoryEventLog();
    this.replay();
  }

  private replay(): void {
    for (const event of this.log.readAll()) {
      if (event.type !== 'ledger_purchase') continue;
      const payload = event.payload as LedgerPurchasePayload;
      this.mutate(payload);
    }
  }

  private holdingsOf(buyerId: string): Holdings {
    let held = this.holdings.get(buyerId);
    if (!held) {
      held = { credits: this.startingCredits, inventory: new Map(), purchases: 0 };
      this.holdings.set(buyerId, held);
    }
    return held;
  }

  private totalHeld(holdings: Holdings): number {
    let sum = 0;
    for (const qty of holdings.inventory.values()) sum += qty;
    return sum;
  }

  private mutate(payload: LedgerPurchasePayload): void {
    const holdings = this.holdingsOf(payload.buyerId);
    const amount = Number(payload.amount);
    holdings.credits -= amount;
    holdings.inventory.set(payload.itemId, (holdings.inventory.get(payload.itemId) ?? 0) + payload.quantity);
    holdings.purchases += 1;
  }

  /**
   * 決済が通った購入を手持ちへ反映する。
   * credits 不足・容量超過は反映せずに落とす（成功に見せない）。呼び出し側は settle が成功したときだけ呼ぶ。
   */
  applyPurchase(input: { buyerId: string; itemId: string; quantity: number; amount: string }): LedgerState {
    if (input.quantity <= 0) throw new LedgerError('数量は 1 以上');
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new LedgerError(`amount が不正: ${input.amount}`);

    const holdings = this.holdingsOf(input.buyerId);
    if (amount > holdings.credits) {
      throw new LedgerError(`credits 不足: 残高 ${holdings.credits} / 要求 ${amount}`);
    }
    if (this.totalHeld(holdings) + input.quantity > this.capacity) {
      throw new LedgerError(
        `手持ち容量を超える: ${this.totalHeld(holdings)}+${input.quantity} > ${this.capacity}`,
      );
    }

    const payload: LedgerPurchasePayload = {
      buyerId: input.buyerId,
      itemId: input.itemId,
      quantity: input.quantity,
      amount: input.amount,
      at: this.now(),
    };
    this.mutate(payload);
    this.log.append<LedgerPurchasePayload>('ledger_purchase', payload, payload.at);
    return this.state(input.buyerId);
  }

  state(buyerId: string): LedgerState {
    const holdings = this.holdingsOf(buyerId);
    return {
      buyerId,
      credits: holdings.credits,
      inventory: [...holdings.inventory.entries()]
        .filter(([, qty]) => qty > 0)
        .map(([itemId, quantity]) => ({ itemId, quantity })),
      held: this.totalHeld(holdings),
      capacity: this.capacity,
      startingCredits: this.startingCredits,
      purchases: holdings.purchases,
      provisional: this.provisional,
    };
  }
}
