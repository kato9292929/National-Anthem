import { arr, bool, num, obj, str } from './guards.js';

/**
 * M7: commission board（主モジュール）。
 * principal が委託を出し、代理エージェントが遠隔交易の各レグを実行し、封印精算で account を締める。
 * world-spec §1 の tamkārum × šamallum ＋ case tablet 精算 = escrow / arbitration。
 */

export type CommissionState =
  | 'open'
  | 'agreed'
  | 'funded'
  | 'in_progress'
  | 'delivered'
  | 'settled'
  | 'disputed'
  | 'refunded'
  | 'cancelled';

export type LegState = 'pending' | 'done' | 'failed';

/** 遠隔地の各レグ。数と扱いは v0 未確定なので、委託ごとに与えられた分だけを持つ。 */
export interface CommissionLeg {
  index: number;
  /** world.config.json の trade_partners の id。 */
  partnerId: string;
  note: string;
  state: LegState;
}

export interface Commission {
  id: string;
  principalId: string;
  agentId: string | null;
  /** 取り扱う品目。config の stall_categories 由来。 */
  itemId: string;
  quantity: number;
  /** 最小単位の整数文字列。単位は config の escrow.unit（現在 TBD）。 */
  amount: string;
  unit: string;
  legs: CommissionLeg[];
  state: CommissionState;
  agreedByPrincipal: boolean;
  agreedByAgent: boolean;
  createdAt: number;
  updatedAt: number;
  /** commission_flow が未確定なので、この委託の条件は仮のもの。 */
  provisional: boolean;
  note: string;
}

export type EscrowState = 'empty' | 'held' | 'released' | 'refunded';

export interface Escrow {
  commissionId: string;
  amount: string;
  unit: string;
  state: EscrowState;
  fundedAt: number | null;
  closedAt: number | null;
}

export type DisputeOutcome = 'release' | 'refund';

export interface Dispute {
  id: string;
  commissionId: string;
  openedBy: string;
  reason: string;
  openedAt: number;
  resolvedAt: number | null;
  outcome: DisputeOutcome | null;
  arbiterId: string | null;
  resolution: string | null;
}

export interface CommissionConfig {
  version: string;
  modules: { primary: string; secondary: string; confirmed: boolean };
  flow: { legs: string; remote_handling: string; settlement_unit: string; confirmed: boolean };
  escrow: {
    unit: string;
    requireBothPartiesToAgree: boolean;
    releaseRequiresPaymentValid: boolean;
    confirmed: boolean;
  };
  arbitration: { outcomes: DisputeOutcome[]; requiresArbiter: boolean; confirmed: boolean };
  reputation: {
    onSettled: { agent: string; principal: string };
    onRefundedForNonDelivery: { agent: string };
    onDisputeResolved: { winner: string; loser: string };
    confirmed: boolean;
  };
  /** 物販デモ（副モジュール・区分A mock）の初期状態。数値は仮値。 */
  storefront: {
    /** 買い手の初期 credits。最小単位の整数（単位は escrow.unit と同じく TBD）。 */
    startingCredits: number;
    /** 手持ちの品数の上限。 */
    inventoryCapacity: number;
    confirmed: boolean;
  };
}

export function validateCommissionConfig(input: unknown, source: string): CommissionConfig {
  const root = obj(input, source, '(root)');
  const modules = obj(root['modules'], source, 'modules');
  const flow = obj(root['flow'], source, 'flow');
  const escrow = obj(root['escrow'], source, 'escrow');
  const arbitration = obj(root['arbitration'], source, 'arbitration');
  const reputation = obj(root['reputation'], source, 'reputation');

  if (str(modules['primary'], source, 'modules.primary') !== 'commission-board') {
    throw new Error(`${source}: 主モジュールは commission-board（経済の重心）`);
  }
  if (str(modules['secondary'], source, 'modules.secondary') !== 'goods-storefront') {
    throw new Error(`${source}: 物販は副モジュール`);
  }

  const outcomes = arr(arbitration['outcomes'], source, 'arbitration.outcomes').map((v, i) =>
    str(v, source, `arbitration.outcomes[${i}]`),
  );
  for (const outcome of outcomes) {
    if (outcome !== 'release' && outcome !== 'refund') {
      throw new Error(`${source}: 未定義の係争結果: ${outcome}（release / refund のみ）`);
    }
  }

  const settled = obj(reputation['onSettled'], source, 'reputation.onSettled');
  const refunded = obj(reputation['onRefundedForNonDelivery'], source, 'reputation.onRefundedForNonDelivery');
  const resolved = obj(reputation['onDisputeResolved'], source, 'reputation.onDisputeResolved');
  const storefront = obj(root['storefront'], source, 'storefront');

  const startingCredits = num(storefront['startingCredits'], source, 'storefront.startingCredits');
  if (!Number.isInteger(startingCredits) || startingCredits < 0) {
    throw new Error(`${source}: storefront.startingCredits は 0 以上の整数（最小単位）`);
  }
  const inventoryCapacity = num(storefront['inventoryCapacity'], source, 'storefront.inventoryCapacity');
  if (!Number.isInteger(inventoryCapacity) || inventoryCapacity <= 0) {
    throw new Error(`${source}: storefront.inventoryCapacity は 1 以上の整数`);
  }

  return {
    version: str(root['version'], source, 'version'),
    modules: {
      primary: 'commission-board',
      secondary: 'goods-storefront',
      confirmed: bool(modules['confirmed'], source, 'modules.confirmed'),
    },
    flow: {
      legs: str(flow['legs'], source, 'flow.legs'),
      remote_handling: str(flow['remote_handling'], source, 'flow.remote_handling'),
      settlement_unit: str(flow['settlement_unit'], source, 'flow.settlement_unit'),
      confirmed: bool(flow['confirmed'], source, 'flow.confirmed'),
    },
    escrow: {
      unit: str(escrow['unit'], source, 'escrow.unit'),
      requireBothPartiesToAgree: bool(escrow['requireBothPartiesToAgree'], source, 'escrow.requireBothPartiesToAgree'),
      releaseRequiresPaymentValid: bool(
        escrow['releaseRequiresPaymentValid'],
        source,
        'escrow.releaseRequiresPaymentValid',
      ),
      confirmed: bool(escrow['confirmed'], source, 'escrow.confirmed'),
    },
    arbitration: {
      outcomes: outcomes as DisputeOutcome[],
      requiresArbiter: bool(arbitration['requiresArbiter'], source, 'arbitration.requiresArbiter'),
      confirmed: bool(arbitration['confirmed'], source, 'arbitration.confirmed'),
    },
    reputation: {
      onSettled: {
        agent: str(settled['agent'], source, 'reputation.onSettled.agent'),
        principal: str(settled['principal'], source, 'reputation.onSettled.principal'),
      },
      onRefundedForNonDelivery: {
        agent: str(refunded['agent'], source, 'reputation.onRefundedForNonDelivery.agent'),
      },
      onDisputeResolved: {
        winner: str(resolved['winner'], source, 'reputation.onDisputeResolved.winner'),
        loser: str(resolved['loser'], source, 'reputation.onDisputeResolved.loser'),
      },
      confirmed: bool(reputation['confirmed'], source, 'reputation.confirmed'),
    },
    storefront: {
      startingCredits,
      inventoryCapacity,
      confirmed: bool(storefront['confirmed'], source, 'storefront.confirmed'),
    },
  };
}
