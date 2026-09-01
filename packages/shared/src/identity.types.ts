/**
 * M3: identity と wallet を分ける。
 * identity は人／エージェントの同一性。wallet は鍵の入れ物。
 * wallet を rotate / revoke しても identity と評判は続く。
 */

export type ParticipantKind = 'human' | 'agent';

/** world-spec §1: standing = 円筒印章の履歴（押印の蓄積）。 */
export type ReputationEventKind =
  | 'payment_settled'
  | 'commission_completed'
  | 'dispute_won'
  | 'payment_late'
  | 'counterparty_vanished'
  | 'dispute_lost';

export interface Identity {
  id: string;
  kind: ParticipantKind;
  /** 委託元（principal）としての立ち位置。エージェントは principal に紐づく。 */
  principalId: string | null;
  /** 外部 identity（ERC-8004 等）への参照。config の external_assets の id を指す。 */
  externalRefs: string[];
  createdAt: number;
  status: 'active' | 'suspended';
}

export type WalletStatus = 'active' | 'revoked';

export interface Wallet {
  id: string;
  identityId: string;
  chain: string;
  address: string;
  kind: 'session' | 'custodial';
  status: WalletStatus;
  createdAt: number;
  revokedAt: number | null;
  /** rotate 元の wallet id。系譜を辿れる。 */
  rotatedFrom: string | null;
  /** 実チェーン上での存在は未検証（区分B）。 */
  verified: boolean;
}

export interface ReputationEvent {
  id: string;
  identityId: string;
  kind: ReputationEventKind;
  weight: number;
  at: number;
  /** 由来の参照（commission id / payment id 等）。 */
  ref: string | null;
  note: string;
}

export interface Standing {
  identityId: string;
  score: number;
  /** 押印の回数（good / bad）。 */
  impressions: { total: number; positive: number; negative: number };
  updatedAt: number;
  /** 内訳。数値も方針も仮値なので、どう出た点数かを必ず示す。 */
  breakdown: StandingBreakdown;
}

export interface StandingBreakdown {
  initial: number;
  /** 時間減衰を掛ける前の重み合計。 */
  rawWeight: number;
  /** 時間減衰を掛けた後の重み合計。 */
  decayedWeight: number;
  halfLifeDays: number;
  /** 直近窓に入っている重大な事故。 */
  recentSevere: { kind: ReputationEventKind; at: number; ref: string | null }[];
  provisional: true;
}

export interface RoomGateResult {
  roomId: string;
  identityId: string;
  allowed: boolean;
  standing: number;
  required: number;
  reason:
    | 'ok'
    | 'standing_too_low'
    | 'unknown_identity'
    | 'suspended'
    | 'insufficient_impressions'
    | 'recent_severe_event';
  /** 判定に使った条件（すべて仮値）。 */
  requirements: { minStanding: number; minImpressions: number; requireNoRecentSevere: boolean };
  impressions: number;
  /** しきい値が仮値であることを呼び出し側にも伝える。 */
  provisional: boolean;
}
