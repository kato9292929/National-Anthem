import type {
  Commission,
  CommissionConfig,
  CommissionLeg,
  Dispute,
  DisputeOutcome,
  ReputationEventKind,
  WorldConfig,
} from '@na/shared';
import type { IdentityService } from '../identity/service.js';
import type { PaymentRecordStore } from '../privacy/records.js';
import type { EventLog } from '../store/event-log.js';
import { EscrowLedger } from './escrow.js';

/**
 * commission board（経済の重心・主モジュール）。
 * principal が委託を出す → 代理エージェントが各レグを実行する → 封印精算で account を締める。
 *
 * - 締結は両者合意でのみ確定する（片方の宣言では state が進まない）。
 * - release は封印精算の検証（payment_valid）が通ってから。検証の中身は受け取らない（M5）。
 * - 完了・不履行・係争の結末は M3 の評判へ写す（standing = 円筒印章の履歴）。
 * - レグ数・遠隔地の扱い・精算単位は v0 未確定。委託ごとに与えられた分だけを持ち、
 *   provisional: true を付けて回す（推測で仕様を埋めない）。
 */

export class CommissionError extends Error {
  override readonly name = 'CommissionError';
}

export interface OpenCommissionInput {
  principalId: string;
  itemId: string;
  quantity: number;
  amount: string;
  legs: { partnerId: string; note?: string }[];
  note?: string;
}

export interface BoardOptions {
  config: CommissionConfig;
  world: WorldConfig;
  identity: IdentityService;
  log: EventLog;
  escrow?: EscrowLedger;
  paymentRecords?: PaymentRecordStore;
  now?: () => number;
}

export class CommissionBoard {
  private readonly commissions = new Map<string, Commission>();
  private readonly disputes = new Map<string, Dispute>();
  readonly escrow: EscrowLedger;
  private readonly now: () => number;
  private counter = 0;

  constructor(private readonly options: BoardOptions) {
    this.now = options.now ?? (() => Date.now());
    this.escrow = options.escrow ?? new EscrowLedger(options.config, options.log, this.now);
    this.replay();
  }

  private replay(): void {
    for (const event of this.options.log.readAll()) {
      if (event.type === 'commission_changed') {
        const commission = event.payload as Commission;
        this.commissions.set(commission.id, commission);
        // id の連番は最大値から続ける（変更イベントの数で増やさない）。
        const seq = Number(commission.id.split('-').at(-1));
        if (Number.isFinite(seq)) this.counter = Math.max(this.counter, seq);
      } else if (event.type === 'dispute_changed') {
        const dispute = event.payload as Dispute;
        this.disputes.set(dispute.id, dispute);
      }
    }
  }

  /** principal が委託を出す。品目とレグは config / world 由来のものだけ。 */
  open(input: OpenCommissionInput): Commission {
    this.options.identity.identity(input.principalId);
    this.assertKnownItem(input.itemId);
    if (input.legs.length === 0) throw new CommissionError('レグが 1 つも無い委託は出せない');
    for (const leg of input.legs) this.assertKnownPartner(leg.partnerId);
    if (!/^\d+$/.test(input.amount)) {
      throw new CommissionError(`金額は最小単位の整数文字列で渡す（実際: ${input.amount}）`);
    }
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new CommissionError(`数量は 1 以上の整数（実際: ${input.quantity}）`);
    }
    const seenLegs = new Set(input.legs.map((leg) => leg.partnerId));
    if (seenLegs.size !== input.legs.length) {
      // レグ数と遠隔地の扱いは未確定なので、同じ相手を重ねる意味を勝手に決めない。
      throw new CommissionError('同じ交易相手のレグが重複している（重ね方は commission_flow 未確定）');
    }

    const at = this.now();
    const commission: Commission = {
      id: this.nextId(),
      principalId: input.principalId,
      agentId: null,
      itemId: input.itemId,
      quantity: input.quantity,
      amount: input.amount,
      unit: this.options.config.escrow.unit,
      legs: input.legs.map<CommissionLeg>((leg, index) => ({
        index,
        partnerId: leg.partnerId,
        note: leg.note ?? '',
        state: 'pending',
      })),
      state: 'open',
      agreedByPrincipal: false,
      agreedByAgent: false,
      createdAt: at,
      updatedAt: at,
      // commission_flow が未確定なので、この委託の条件は仮のもの。
      provisional: !this.options.config.flow.confirmed,
      note: input.note ?? '',
    };
    return this.write(commission);
  }

  /** 代理エージェントが受ける意思を示す。これだけでは締結しない。 */
  proposeAgent(commissionId: string, agentId: string): Commission {
    const commission = this.require(commissionId);
    const agent = this.options.identity.identity(agentId);
    if (commission.state !== 'open') throw new CommissionError(`open でない委託には応募できない: ${commission.state}`);
    if (agent.id === commission.principalId) throw new CommissionError('principal 自身は代理人になれない');
    return this.write({ ...commission, agentId: agent.id, updatedAt: this.now() });
  }

  /** 両者が合意して初めて締結する。 */
  agree(commissionId: string, partyId: string): Commission {
    const commission = this.require(commissionId);
    // 当事者かどうかを先に見る（状態より当事者性のほうが根本的な拒否理由）。
    if (partyId !== commission.principalId && partyId !== commission.agentId) {
      throw new CommissionError(`当事者でない: ${partyId}`);
    }
    if (commission.agentId === null) throw new CommissionError('代理人が決まっていない');
    if (commission.state !== 'open') throw new CommissionError(`open でない委託は締結できない: ${commission.state}`);

    const next: Commission =
      partyId === commission.principalId
        ? { ...commission, agreedByPrincipal: true }
        : { ...commission, agreedByAgent: true };
    const both = next.agreedByPrincipal && next.agreedByAgent;
    if (this.options.config.escrow.requireBothPartiesToAgree && !both) {
      return this.write({ ...next, updatedAt: this.now() });
    }
    return this.write({ ...next, state: 'agreed', updatedAt: this.now() });
  }

  /** 締結後に escrow を積む。 */
  fund(commissionId: string): Commission {
    const commission = this.require(commissionId);
    if (commission.state !== 'agreed') throw new CommissionError(`締結前に escrow は積まない: ${commission.state}`);
    this.escrow.fund(commission.id, commission.amount);
    return this.write({ ...commission, state: 'funded', updatedAt: this.now() });
  }

  /** 各レグの実行。遠隔地の扱いは未確定なので、結果だけを記録する。 */
  completeLeg(commissionId: string, index: number, result: 'done' | 'failed', note = ''): Commission {
    const commission = this.require(commissionId);
    if (commission.state !== 'funded' && commission.state !== 'in_progress') {
      throw new CommissionError(`実行できる状態でない: ${commission.state}`);
    }
    const leg = commission.legs[index];
    if (!leg) throw new CommissionError(`無いレグ: ${index}`);
    if (leg.state !== 'pending') throw new CommissionError(`既に ${leg.state} のレグ: ${index}`);

    const legs = commission.legs.map((l) => (l.index === index ? { ...l, state: result, note: note || l.note } : l));
    const allDone = legs.every((l) => l.state === 'done');
    return this.write({
      ...commission,
      legs,
      state: allDone ? 'delivered' : 'in_progress',
      updatedAt: this.now(),
    });
  }

  /**
   * 封印精算。検証は M5 の Gateway 経由で、返るのは payment_valid だけ。
   * 通らなければ release しない。
   */
  settle(commissionId: string, input: { paymentValid: boolean }): Commission {
    const commission = this.require(commissionId);
    if (commission.state !== 'delivered') {
      throw new CommissionError(`納品前に精算しない: ${commission.state}`);
    }
    this.escrow.release(commission.id, { paymentValid: input.paymentValid });
    this.options.paymentRecords?.record({ payment_valid: input.paymentValid, ref: commission.id });

    const settled = this.write({ ...commission, state: 'settled', updatedAt: this.now() });
    // 完了は評判に積む（standing = 円筒印章の履歴）。
    if (settled.agentId) {
      this.recordReputation(settled.agentId, this.options.config.reputation.onSettled.agent, settled.id);
    }
    this.recordReputation(settled.principalId, this.options.config.reputation.onSettled.principal, settled.id);
    return settled;
  }

  /** 不履行での払い戻し。代理人の評判が下がる。 */
  refundForNonDelivery(commissionId: string, reason: string): Commission {
    const commission = this.require(commissionId);
    if (commission.state === 'settled' || commission.state === 'refunded') {
      throw new CommissionError(`既に閉じている委託: ${commission.state}`);
    }
    this.escrow.refund(commission.id, reason);
    const refunded = this.write({ ...commission, state: 'refunded', updatedAt: this.now() });
    if (refunded.agentId) {
      this.recordReputation(
        refunded.agentId,
        this.options.config.reputation.onRefundedForNonDelivery.agent,
        refunded.id,
      );
    }
    return refunded;
  }

  openDispute(commissionId: string, openedBy: string, reason: string): Dispute {
    const commission = this.require(commissionId);
    if (commission.state === 'settled' || commission.state === 'refunded') {
      throw new CommissionError(`閉じた委託に係争は起こせない: ${commission.state}`);
    }
    if (openedBy !== commission.principalId && openedBy !== commission.agentId) {
      throw new CommissionError(`当事者でない: ${openedBy}`);
    }
    const dispute: Dispute = {
      id: `dispute-${commission.id}`,
      commissionId: commission.id,
      openedBy,
      reason,
      openedAt: this.now(),
      resolvedAt: null,
      outcome: null,
      arbiterId: null,
      resolution: null,
    };
    this.disputes.set(dispute.id, dispute);
    this.options.log.append('dispute_changed', dispute, dispute.openedAt);
    this.write({ ...commission, state: 'disputed', updatedAt: this.now() });
    return dispute;
  }

  /** 係争の解決は release / refund の二択。分割は未定義なので実装しない。 */
  resolveDispute(input: {
    disputeId: string;
    arbiterId: string;
    outcome: DisputeOutcome;
    resolution: string;
    paymentValid?: boolean;
  }): { dispute: Dispute; commission: Commission } {
    const dispute = this.disputes.get(input.disputeId);
    if (!dispute) throw new CommissionError(`無い係争: ${input.disputeId}`);
    if (dispute.resolvedAt !== null) throw new CommissionError('既に解決済みの係争');
    if (!this.options.config.arbitration.outcomes.includes(input.outcome)) {
      throw new CommissionError(`未定義の結果: ${input.outcome}`);
    }
    if (this.options.config.arbitration.requiresArbiter) {
      this.options.identity.identity(input.arbiterId);
      const commission = this.require(dispute.commissionId);
      if (input.arbiterId === commission.principalId || input.arbiterId === commission.agentId) {
        throw new CommissionError('当事者は arbiter になれない');
      }
    }

    const commission = this.require(dispute.commissionId);
    let next: Commission;
    if (input.outcome === 'release') {
      this.escrow.release(commission.id, { paymentValid: input.paymentValid ?? null });
      this.options.paymentRecords?.record({ payment_valid: input.paymentValid ?? false, ref: commission.id });
      next = this.write({ ...commission, state: 'settled', updatedAt: this.now() });
    } else {
      this.escrow.refund(commission.id, `arbitration: ${input.resolution}`);
      next = this.write({ ...commission, state: 'refunded', updatedAt: this.now() });
    }

    const resolved: Dispute = {
      ...dispute,
      resolvedAt: this.now(),
      outcome: input.outcome,
      arbiterId: input.arbiterId,
      resolution: input.resolution,
    };
    this.disputes.set(resolved.id, resolved);
    this.options.log.append('dispute_changed', resolved, resolved.resolvedAt ?? this.now());

    // 勝者・敗者を評判に写す。
    const winner = input.outcome === 'release' ? commission.agentId : commission.principalId;
    const loser = input.outcome === 'release' ? commission.principalId : commission.agentId;
    if (winner) this.recordReputation(winner, this.options.config.reputation.onDisputeResolved.winner, commission.id);
    if (loser) this.recordReputation(loser, this.options.config.reputation.onDisputeResolved.loser, commission.id);

    return { dispute: resolved, commission: next };
  }

  get(commissionId: string): Commission | null {
    return this.commissions.get(commissionId) ?? null;
  }

  list(): Commission[] {
    return [...this.commissions.values()];
  }

  disputeFor(commissionId: string): Dispute | null {
    return [...this.disputes.values()].find((d) => d.commissionId === commissionId) ?? null;
  }

  private recordReputation(identityId: string, kind: string, ref: string): void {
    this.options.identity.recordReputation({
      identityId,
      kind: kind as ReputationEventKind,
      ref,
      note: 'commission',
    });
  }

  private assertKnownItem(itemId: string): void {
    const known = [
      ...this.options.world.stall_categories.imports,
      ...this.options.world.stall_categories.exports,
    ].some((c) => c.id === itemId);
    if (!known) throw new CommissionError(`config に無い品目: ${itemId}`);
  }

  private assertKnownPartner(partnerId: string): void {
    if (!this.options.world.trade_partners.some((p) => p.id === partnerId)) {
      throw new CommissionError(`config に無い交易相手: ${partnerId}`);
    }
  }

  private require(commissionId: string): Commission {
    const commission = this.commissions.get(commissionId);
    if (!commission) throw new CommissionError(`無い委託: ${commissionId}`);
    return commission;
  }

  private write(commission: Commission): Commission {
    this.commissions.set(commission.id, commission);
    this.options.log.append('commission_changed', commission, commission.updatedAt);
    return commission;
  }

  private nextId(): string {
    this.counter += 1;
    return `commission-${String(this.counter).padStart(4, '0')}`;
  }
}
