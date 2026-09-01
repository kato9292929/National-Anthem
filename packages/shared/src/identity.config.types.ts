import { arr, bool, num, obj, str } from './guards.js';
import type { ReputationEventKind } from './identity.types.js';

/** config/identity.config.json と config/rooms.config.json の型と検証。 */

export interface ExternalErc8004 {
  id: string;
  chain: string;
  agentId: string;
  issuer: string;
  confirmed: boolean;
  /** 実チェーン照会は区分B（加藤さん環境）。ここが false の間は未検証。 */
  verified: boolean;
}

export interface ExternalSigner {
  id: string;
  kind: string;
  address: string;
  confirmed: boolean;
  verified: boolean;
}

export interface ExternalCustodialWallet {
  id: string;
  provider: string;
  chain: string;
  address: string;
  confirmed: boolean;
  verified: boolean;
}

export interface StandingPolicy {
  /** すべて仮値。効き方の方針そのものが未確定。 */
  confirmed: boolean;
  /** 押印の効きが半分になるまでの日数（古い実績ほど効かない）。 */
  halfLifeDays: number;
  /** 「直近」と見なす窓（日）。 */
  recentWindowDays: number;
  /** 直近窓にあると門を閉じる重大な事故。 */
  severeKinds: ReputationEventKind[];
  severeBlocksGates: boolean;
}

export interface StandingConfig {
  confirmed: boolean;
  initial: number;
  min: number;
  max: number;
  weights: Record<ReputationEventKind, number>;
  policy: StandingPolicy;
}

export interface IdentityConfig {
  version: string;
  external_assets: {
    erc8004: ExternalErc8004[];
    signers: ExternalSigner[];
    custodial_wallets: ExternalCustodialWallet[];
  };
  standing: StandingConfig;
  session_wallet: { confirmed: boolean; default_chain: string; rotate_keeps_reputation: boolean };
}

export interface RoomConfig {
  id: string;
  label_ja: string;
  /** 固有名は加藤さん確定待ち。naming.* と同じ扱い。 */
  name_placeholder: string;
  name_confirmed: boolean;
  minStanding: number;
  /** 点数だけでなく、押印の数も見る（仮値）。 */
  minImpressions: number;
  /** 直近の重大事故があれば点数に関わらず閉じる（仮値）。 */
  requireNoRecentSevere: boolean;
  gate_confirmed: boolean;
}

export interface RoomsConfig {
  version: string;
  rooms: RoomConfig[];
}

const EVENT_KINDS: ReputationEventKind[] = [
  'payment_settled',
  'commission_completed',
  'dispute_won',
  'payment_late',
  'counterparty_vanished',
  'dispute_lost',
];

export function validateIdentityConfig(input: unknown, source: string): IdentityConfig {
  const root = obj(input, source, '(root)');
  const assets = obj(root['external_assets'], source, 'external_assets');
  const standing = obj(root['standing'], source, 'standing');
  const weights = obj(standing['weights'], source, 'standing.weights');
  const wallet = obj(root['session_wallet'], source, 'session_wallet');

  const weightMap = {} as Record<ReputationEventKind, number>;
  for (const kind of EVENT_KINDS) {
    weightMap[kind] = num(weights[kind], source, `standing.weights.${kind}`);
  }

  return {
    version: str(root['version'], source, 'version'),
    external_assets: {
      erc8004: arr(assets['erc8004'], source, 'external_assets.erc8004').map((v, i) => {
        const o = obj(v, source, `external_assets.erc8004[${i}]`);
        return {
          id: str(o['id'], source, `external_assets.erc8004[${i}].id`),
          chain: str(o['chain'], source, `external_assets.erc8004[${i}].chain`),
          agentId: str(o['agentId'], source, `external_assets.erc8004[${i}].agentId`),
          issuer: str(o['issuer'], source, `external_assets.erc8004[${i}].issuer`),
          confirmed: bool(o['confirmed'], source, `external_assets.erc8004[${i}].confirmed`),
          verified: bool(o['verified'], source, `external_assets.erc8004[${i}].verified`),
        };
      }),
      signers: arr(assets['signers'], source, 'external_assets.signers').map((v, i) => {
        const o = obj(v, source, `external_assets.signers[${i}]`);
        return {
          id: str(o['id'], source, `external_assets.signers[${i}].id`),
          kind: str(o['kind'], source, `external_assets.signers[${i}].kind`),
          address: str(o['address'], source, `external_assets.signers[${i}].address`),
          confirmed: bool(o['confirmed'], source, `external_assets.signers[${i}].confirmed`),
          verified: bool(o['verified'], source, `external_assets.signers[${i}].verified`),
        };
      }),
      custodial_wallets: arr(assets['custodial_wallets'], source, 'external_assets.custodial_wallets').map(
        (v, i) => {
          const o = obj(v, source, `external_assets.custodial_wallets[${i}]`);
          return {
            id: str(o['id'], source, `external_assets.custodial_wallets[${i}].id`),
            provider: str(o['provider'], source, `external_assets.custodial_wallets[${i}].provider`),
            chain: str(o['chain'], source, `external_assets.custodial_wallets[${i}].chain`),
            address: str(o['address'], source, `external_assets.custodial_wallets[${i}].address`),
            confirmed: bool(o['confirmed'], source, `external_assets.custodial_wallets[${i}].confirmed`),
            verified: bool(o['verified'], source, `external_assets.custodial_wallets[${i}].verified`),
          };
        },
      ),
    },
    standing: {
      confirmed: bool(standing['confirmed'], source, 'standing.confirmed'),
      initial: num(standing['initial'], source, 'standing.initial'),
      min: num(standing['min'], source, 'standing.min'),
      max: num(standing['max'], source, 'standing.max'),
      weights: weightMap,
      policy: (() => {
        const policy = obj(standing['policy'], source, 'standing.policy');
        const severeKinds = arr(policy['severeKinds'], source, 'standing.policy.severeKinds').map((v, i) => {
          const kind = str(v, source, `standing.policy.severeKinds[${i}]`);
          if (!EVENT_KINDS.includes(kind as ReputationEventKind)) {
            throw new Error(`${source}: standing.policy.severeKinds[${i}] が未知の種別: ${kind}`);
          }
          return kind as ReputationEventKind;
        });
        const halfLifeDays = num(policy['halfLifeDays'], source, 'standing.policy.halfLifeDays');
        if (halfLifeDays <= 0) throw new Error(`${source}: standing.policy.halfLifeDays は 0 より大きいこと`);
        return {
          confirmed: bool(policy['confirmed'], source, 'standing.policy.confirmed'),
          halfLifeDays,
          recentWindowDays: num(policy['recentWindowDays'], source, 'standing.policy.recentWindowDays'),
          severeKinds,
          severeBlocksGates: bool(policy['severeBlocksGates'], source, 'standing.policy.severeBlocksGates'),
        };
      })(),
    },
    session_wallet: {
      confirmed: bool(wallet['confirmed'], source, 'session_wallet.confirmed'),
      default_chain: str(wallet['default_chain'], source, 'session_wallet.default_chain'),
      rotate_keeps_reputation: bool(
        wallet['rotate_keeps_reputation'],
        source,
        'session_wallet.rotate_keeps_reputation',
      ),
    },
  };
}

export function validateRoomsConfig(input: unknown, source: string): RoomsConfig {
  const root = obj(input, source, '(root)');
  const rooms = arr(root['rooms'], source, 'rooms').map((v, i) => {
    const o = obj(v, source, `rooms[${i}]`);
    return {
      id: str(o['id'], source, `rooms[${i}].id`),
      label_ja: str(o['label_ja'], source, `rooms[${i}].label_ja`),
      name_placeholder: str(o['name_placeholder'], source, `rooms[${i}].name_placeholder`),
      name_confirmed: bool(o['name_confirmed'], source, `rooms[${i}].name_confirmed`),
      minStanding: num(o['minStanding'], source, `rooms[${i}].minStanding`),
      minImpressions: num(o['minImpressions'], source, `rooms[${i}].minImpressions`),
      requireNoRecentSevere: bool(o['requireNoRecentSevere'], source, `rooms[${i}].requireNoRecentSevere`),
      gate_confirmed: bool(o['gate_confirmed'], source, `rooms[${i}].gate_confirmed`),
    };
  });
  if (rooms.length === 0) throw new Error(`${source}: rooms が空`);
  return { version: str(root['version'], source, 'version'), rooms };
}
