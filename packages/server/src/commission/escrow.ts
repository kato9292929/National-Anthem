import type { CommissionConfig, Escrow } from '@na/shared';
import type { EventLog } from '../store/event-log.js';

/**
 * escrow。release と refund の両方を持つ。
 * 二重 release / 二重 refund はしない。締結していない委託には積まない。
 * 精算単位は未確定なので、金額は最小単位の整数文字列のまま扱う（丸め誤差を作らない）。
 */

export class EscrowError extends Error {
  override readonly name = 'EscrowError';
}

export class EscrowLedger {
  private readonly escrows = new Map<string, Escrow>();

  constructor(
    private readonly config: CommissionConfig,
    private readonly log: EventLog,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.replay();
  }

  private replay(): void {
    for (const event of this.log.readAll()) {
      if (event.type !== 'escrow_changed') continue;
      const escrow = event.payload as Escrow;
      this.escrows.set(escrow.commissionId, escrow);
    }
  }

  get(commissionId: string): Escrow | null {
    return this.escrows.get(commissionId) ?? null;
  }

  fund(commissionId: string, amount: string): Escrow {
    if (!/^\d+$/.test(amount)) {
      throw new EscrowError(`金額は最小単位の整数文字列で渡す（実際: ${amount}）`);
    }
    if (amount === '0') throw new EscrowError('0 の escrow は積まない');
    const existing = this.escrows.get(commissionId);
    if (existing && existing.state !== 'empty') {
      throw new EscrowError(`既に ${existing.state} の escrow がある: ${commissionId}`);
    }
    return this.write({
      commissionId,
      amount,
      unit: this.config.escrow.unit,
      state: 'held',
      fundedAt: this.now(),
      closedAt: null,
    });
  }

  /** 納品が認められたとき。payment_valid が必要な設定なら、それ無しでは開けない。 */
  release(commissionId: string, input: { paymentValid: boolean | null }): Escrow {
    const escrow = this.require(commissionId);
    if (escrow.state !== 'held') throw new EscrowError(`held でない escrow は release できない: ${escrow.state}`);
    if (this.config.escrow.releaseRequiresPaymentValid) {
      if (input.paymentValid === null) {
        throw new EscrowError('payment_valid が無いまま release しない（封印精算の検証が先）');
      }
      if (!input.paymentValid) throw new EscrowError('payment_valid が false なので release しない');
    }
    return this.write({ ...escrow, state: 'released', closedAt: this.now() });
  }

  refund(commissionId: string, reason: string): Escrow {
    const escrow = this.require(commissionId);
    if (escrow.state !== 'held') throw new EscrowError(`held でない escrow は refund できない: ${escrow.state}`);
    const next = this.write({ ...escrow, state: 'refunded', closedAt: this.now() });
    this.log.append('escrow_refund_reason', { commissionId, reason }, this.now());
    return next;
  }

  private require(commissionId: string): Escrow {
    const escrow = this.escrows.get(commissionId);
    if (!escrow) throw new EscrowError(`escrow が無い: ${commissionId}`);
    return escrow;
  }

  private write(escrow: Escrow): Escrow {
    this.escrows.set(escrow.commissionId, escrow);
    this.log.append('escrow_changed', escrow, this.now());
    return escrow;
  }
}
