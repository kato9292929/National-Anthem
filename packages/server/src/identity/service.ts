import { createRng, hashString } from '@na/shared';
import type {
  Identity,
  IdentityConfig,
  ParticipantKind,
  ReputationEvent,
  ReputationEventKind,
  RoomGateResult,
  RoomsConfig,
  Standing,
  Wallet,
} from '@na/shared';
import { MemoryEventLog, type EventLog } from '../store/event-log.js';

/**
 * M3: identity ≠ wallet。
 * - identity は人／エージェントの同一性。wallet は鍵の入れ物にすぎない。
 * - wallet を rotate / revoke しても identity と評判は続く（config の rotate_keeps_reputation）。
 * - standing は円筒印章の履歴（押印の蓄積）として reputation event から算出する。
 *
 * 未検証（区分B）: 実 ERC-8004 照会と Circle DCW の実 wallet 発行は加藤さん環境で消化する。
 * ここで作る session wallet の address は mock: 前置きの仮アドレスで、実チェーン上には存在しない。
 */

export const MOCK_ADDRESS_PREFIX = 'mock:';

export interface IdentityServiceOptions {
  identityConfig: IdentityConfig;
  roomsConfig: RoomsConfig;
  log?: EventLog;
  /** 仮アドレスの生成を決定論にする。 */
  seed?: number;
  now?: () => number;
}

interface IdentityCreatedPayload {
  identity: Identity;
}
interface WalletCreatedPayload {
  wallet: Wallet;
}
interface WalletRevokedPayload {
  walletId: string;
  at: number;
  reason: string;
}
interface ReputationPayload {
  event: ReputationEvent;
}

export class IdentityService {
  private readonly identities = new Map<string, Identity>();
  private readonly wallets = new Map<string, Wallet>();
  private readonly reputation: ReputationEvent[] = [];
  private readonly rng: ReturnType<typeof createRng>;
  private readonly now: () => number;
  private counter = 0;

  constructor(private readonly options: IdentityServiceOptions) {
    this.rng = createRng((options.seed ?? hashString('na-identity')) >>> 0);
    this.now = options.now ?? (() => Date.now());
    this.replay();
  }

  private get log(): EventLog {
    return (this.options.log ??= new MemoryEventLog());
  }

  /** 保存済みイベントから状態を作り直す。再起動しても続く。 */
  private replay(): void {
    for (const event of this.log.readAll()) {
      switch (event.type) {
        case 'identity_created': {
          const { identity } = event.payload as IdentityCreatedPayload;
          this.identities.set(identity.id, identity);
          this.counter += 1;
          break;
        }
        case 'wallet_created': {
          const { wallet } = event.payload as WalletCreatedPayload;
          this.wallets.set(wallet.id, wallet);
          this.counter += 1;
          break;
        }
        case 'wallet_revoked': {
          const { walletId, at } = event.payload as WalletRevokedPayload;
          const wallet = this.wallets.get(walletId);
          if (!wallet) throw new Error(`ログに無い wallet の revoke: ${walletId}`);
          this.wallets.set(walletId, { ...wallet, status: 'revoked', revokedAt: at });
          break;
        }
        case 'reputation_event': {
          const { event: reputationEvent } = event.payload as ReputationPayload;
          this.reputation.push(reputationEvent);
          break;
        }
        default:
          throw new Error(`未知のイベント種別: ${event.type}`);
      }
    }
  }

  createIdentity(input: {
    kind: ParticipantKind;
    principalId?: string | null;
    externalRefs?: string[];
  }): Identity {
    const principalId = input.principalId ?? null;
    if (principalId !== null && !this.identities.has(principalId)) {
      throw new Error(`未知の principal: ${principalId}`);
    }
    for (const ref of input.externalRefs ?? []) this.assertKnownExternalRef(ref);

    const identity: Identity = {
      id: this.nextId('id'),
      kind: input.kind,
      principalId,
      externalRefs: input.externalRefs ?? [],
      createdAt: this.now(),
      status: 'active',
    };
    this.identities.set(identity.id, identity);
    this.log.append<IdentityCreatedPayload>('identity_created', { identity }, identity.createdAt);
    return identity;
  }

  /**
   * session wallet を発行する。identity とは別物で、いつでも捨てられる。
   * 実キー発行は区分B。ここでは verified:false の仮アドレスを持つ。
   */
  createSessionWallet(identityId: string, chain?: string, rotatedFrom: string | null = null): Wallet {
    const identity = this.requireIdentity(identityId);
    const wallet: Wallet = {
      id: this.nextId('wallet'),
      identityId: identity.id,
      chain: chain ?? this.options.identityConfig.session_wallet.default_chain,
      address: this.mockAddress(),
      kind: 'session',
      status: 'active',
      createdAt: this.now(),
      revokedAt: null,
      rotatedFrom,
      verified: false,
    };
    this.wallets.set(wallet.id, wallet);
    this.log.append<WalletCreatedPayload>('wallet_created', { wallet }, wallet.createdAt);
    return wallet;
  }

  /** config の確定値（Circle DCW 等）を identity に結ぶ。実在確認は区分B。 */
  attachCustodialWallet(identityId: string, assetId: string): Wallet {
    const identity = this.requireIdentity(identityId);
    const asset = this.options.identityConfig.external_assets.custodial_wallets.find(
      (w) => w.id === assetId,
    );
    if (!asset) throw new Error(`config に無い custodial wallet: ${assetId}`);
    const wallet: Wallet = {
      id: this.nextId('wallet'),
      identityId: identity.id,
      chain: asset.chain,
      address: asset.address,
      kind: 'custodial',
      status: 'active',
      createdAt: this.now(),
      revokedAt: null,
      rotatedFrom: null,
      verified: asset.verified,
    };
    this.wallets.set(wallet.id, wallet);
    this.log.append<WalletCreatedPayload>('wallet_created', { wallet }, wallet.createdAt);
    return wallet;
  }

  revokeWallet(walletId: string, reason: string): Wallet {
    const wallet = this.requireWallet(walletId);
    if (wallet.status === 'revoked') return wallet;
    const at = this.now();
    const revoked: Wallet = { ...wallet, status: 'revoked', revokedAt: at };
    this.wallets.set(walletId, revoked);
    this.log.append<WalletRevokedPayload>('wallet_revoked', { walletId, at, reason }, at);
    return revoked;
  }

  /** 旧 wallet を revoke して新しい session wallet を出す。identity と評判はそのまま。 */
  rotateWallet(walletId: string, reason = 'rotate'): Wallet {
    const previous = this.requireWallet(walletId);
    this.revokeWallet(walletId, reason);
    // rotate 元はログに載せる。再生しても系譜が残る。
    return this.createSessionWallet(previous.identityId, previous.chain, previous.id);
  }

  recordReputation(input: {
    identityId: string;
    kind: ReputationEventKind;
    ref?: string | null;
    note?: string;
  }): ReputationEvent {
    const identity = this.requireIdentity(input.identityId);
    const weight = this.options.identityConfig.standing.weights[input.kind];
    if (weight === undefined) throw new Error(`config に重みが無い: ${input.kind}`);
    const event: ReputationEvent = {
      id: this.nextId('rep'),
      identityId: identity.id,
      kind: input.kind,
      weight,
      at: this.now(),
      ref: input.ref ?? null,
      note: input.note ?? '',
    };
    this.reputation.push(event);
    this.log.append<ReputationPayload>('reputation_event', { event }, event.at);
    return event;
  }

  standing(identityId: string): Standing {
    const identity = this.requireIdentity(identityId);
    const { initial, min, max } = this.options.identityConfig.standing;
    const events = this.reputation.filter((e) => e.identityId === identity.id);
    const raw = events.reduce((sum, e) => sum + e.weight, initial);
    return {
      identityId: identity.id,
      score: Math.max(min, Math.min(max, raw)),
      impressions: {
        total: events.length,
        positive: events.filter((e) => e.weight > 0).length,
        negative: events.filter((e) => e.weight < 0).length,
      },
      updatedAt: events.at(-1)?.at ?? identity.createdAt,
    };
  }

  /** standing が room の開閉に効く。しきい値は仮値なので provisional を必ず返す。 */
  canEnter(identityId: string, roomId: string): RoomGateResult {
    const room = this.options.roomsConfig.rooms.find((r) => r.id === roomId);
    if (!room) throw new Error(`未知の room: ${roomId}`);
    const identity = this.identities.get(identityId);
    if (!identity) {
      return {
        roomId,
        identityId,
        allowed: false,
        standing: 0,
        required: room.minStanding,
        reason: 'unknown_identity',
        provisional: !room.gate_confirmed,
      };
    }
    const score = this.standing(identityId).score;
    const reason: RoomGateResult['reason'] =
      identity.status === 'suspended'
        ? 'suspended'
        : score >= room.minStanding
          ? 'ok'
          : 'standing_too_low';
    return {
      roomId,
      identityId,
      allowed: reason === 'ok',
      standing: score,
      required: room.minStanding,
      reason,
      provisional: !room.gate_confirmed,
    };
  }

  identity(identityId: string): Identity {
    return this.requireIdentity(identityId);
  }

  walletsOf(identityId: string): Wallet[] {
    return [...this.wallets.values()].filter((w) => w.identityId === identityId);
  }

  activeWallet(identityId: string): Wallet | null {
    return this.walletsOf(identityId).find((w) => w.status === 'active') ?? null;
  }

  reputationOf(identityId: string): ReputationEvent[] {
    return this.reputation.filter((e) => e.identityId === identityId);
  }

  listIdentities(): Identity[] {
    return [...this.identities.values()];
  }

  private requireIdentity(identityId: string): Identity {
    const identity = this.identities.get(identityId);
    if (!identity) throw new Error(`未知の identity: ${identityId}`);
    return identity;
  }

  private requireWallet(walletId: string): Wallet {
    const wallet = this.wallets.get(walletId);
    if (!wallet) throw new Error(`未知の wallet: ${walletId}`);
    return wallet;
  }

  private assertKnownExternalRef(ref: string): void {
    const { erc8004, signers, custodial_wallets } = this.options.identityConfig.external_assets;
    const known = [...erc8004, ...signers, ...custodial_wallets].some((a) => a.id === ref);
    if (!known) throw new Error(`config に無い external ref: ${ref}`);
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${String(this.counter).padStart(4, '0')}`;
  }

  /** 実チェーン上のアドレスではないことが見て分かる形にする（黙って本物に見せない）。 */
  private mockAddress(): string {
    let out = '';
    for (let i = 0; i < 16; i++) out += Math.floor(this.rng.next() * 16).toString(16);
    return `${MOCK_ADDRESS_PREFIX}${out}`;
  }
}
