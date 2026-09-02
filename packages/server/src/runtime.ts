import { resolve } from 'node:path';
import {
  assertVerifiedHasEvidence,
  collectVerifiedFlags,
  seedFrom,
  unconfirmedNames,
  unconfirmedPresentation,
  verificationSummary,
  type IdentityConfig,
  type RoomsConfig,
  type WorldConfig,
  type AgentConfig,
  type CommissionConfig,
  type MarketStructureConfig,
  type PresentationConfig,
  type PrivacyConfig,
  type VerificationEvidence,
  type X402Config,
} from '@na/shared';
import {
  loadAgentConfig,
  loadCommissionConfig,
  loadIdentityConfig,
  loadMarketStructureConfig,
  loadPresentationConfig,
  loadVerificationEvidence,
  loadPrivacyConfig,
  loadRoomsConfig,
  loadWorldConfig,
  loadX402Config,
} from '@na/shared/node';
import { IdentityService } from './identity/service.js';
import { createAdapterRegistry, type AdapterRegistry } from './adapters/registry.js';
import { evaluateGates, type GateResult } from './agent/gate.js';
import { CommissionBoard } from './commission/board.js';
import { GoodsStorefront } from './commission/storefront.js';
import { loadMeasurement } from './agent/dry-run.js';
import { createDelegatingMxe, createHttpMxeClient, createMockMxe, PrivateGateway } from './privacy/gateway.js';
import { PaymentRecordStore } from './privacy/records.js';
import { FeePayerResolver } from './x402/challenge.js';
import { FacilitatorClient } from './x402/facilitator.js';
import { Paywall } from './x402/paywall.js';
import { createX402Service, type X402Service } from './x402/service.js';
import { FileEventLog, MemoryEventLog, type EventLog } from './store/event-log.js';
import { CURRENT_MILESTONE, loadDotEnv, resolveEnv, type ResolvedEnv } from './env.js';
import { MarketSimulation } from './market/simulation.js';
import { TUNING_PROVISIONAL_NOTE } from './market/tuning.js';

export interface Runtime {
  config: WorldConfig;
  configPath: string;
  env: ResolvedEnv;
  sim: MarketSimulation;
  seedInput: string;
  marketStructure: MarketStructureConfig;
  /** 見た目の設定。サーバは中身を読まず、そのまま配るだけ。 */
  renderConfig: PresentationConfig;
  identityConfig: IdentityConfig;
  roomsConfig: RoomsConfig;
  identity: IdentityService;
  eventLog: EventLog;
  x402Config: X402Config;
  x402: X402Service;
  /** 我々のエンドポイントを 402 でゲートする口。 */
  paywall: Paywall;
  privacyConfig: PrivacyConfig;
  evidence: VerificationEvidence;
  gateway: PrivateGateway;
  paymentRecords: PaymentRecordStore;
  /** 実 MXE に向いているか（未検証）、facilitator 委譲か、結線確認用の stub か。 */
  gatewayMode: 'http' | 'facilitator' | 'mock';
  agentConfig: AgentConfig;
  agentGate: GateResult;
  adapters: AdapterRegistry;
  commissionConfig: CommissionConfig;
  board: CommissionBoard;
  storefront: GoodsStorefront;
  /**
   * 認証は未実装（この段階の範囲外）。ローカルの単一 session identity を仮で立てる。
   * 複数プレイヤーの認証・セッション管理は別途。
   */
  localPlayerId: string;
}

/** 起動時に必ず通る道。config と env はここでしか読まない。 */
export function createRuntime(cwd = process.cwd()): Runtime {
  loadDotEnv(cwd);
  const env = resolveEnv(process.env, CURRENT_MILESTONE);
  const { config, path } = loadWorldConfig(process.env);
  const seedInput = env.require('NA_MARKET_SEED');
  const marketStructure = loadMarketStructureConfig(process.env).value;
  const renderConfig = loadPresentationConfig(process.env).value;
  const sim = new MarketSimulation({ config, seed: seedFrom(seedInput), structure: marketStructure });

  const identityConfig = loadIdentityConfig(process.env).value;
  const roomsConfig = loadRoomsConfig(process.env).value;
  const dataDir = env.get('NA_DATA_DIR');
  const eventLog: EventLog = dataDir ? new FileEventLog(resolve(cwd, dataDir, 'events.jsonl')) : new MemoryEventLog();
  const identity = new IdentityService({
    identityConfig,
    roomsConfig,
    log: eventLog,
    seed: seedFrom(seedInput),
  });
  const existing = identity.listIdentities().find((i) => i.kind === 'human');
  const localPlayer = existing ?? identity.createIdentity({ kind: 'human', externalRefs: ['base'] });
  if (!identity.activeWallet(localPlayer.id)) identity.createSessionWallet(localPlayer.id);

  const x402Config = loadX402Config(process.env).value;
  const x402 = createX402Service(x402Config, process.env);

  const privacyConfig = loadPrivacyConfig(process.env).value;
  // 実 facilitator は env で明示されたときだけ使う。
  // config の URL は「どこに繋ぐか」の記録であって、既定で繋ぎに行くものではない
  // （到達できない相手に既定で向けると、開発時の内部フローまで落ちる）。
  const facilitatorUrl = env.get('NA_X402_FACILITATOR_URL');
  const clusterUrl = env.get('NA_ARCIUM_CLUSTER_URL');
  const facilitatorUrlForGateway = facilitatorUrl;
  const facilitatorForGateway = facilitatorUrlForGateway ? new FacilitatorClient(facilitatorUrlForGateway) : null;
  /**
   * 実 MXE が無い間の検証。常に true を返す stub は使わない
   * （それで資源のゲートを通すと、払っていない相手を通してしまう）。
   * facilitator があるならそこへ委ね、無いときだけ結線確認用の stub。
   */
  const gatewayMode: 'http' | 'facilitator' | 'mock' = clusterUrl
    ? 'http'
    : facilitatorForGateway
      ? 'facilitator'
      : 'mock';
  const gateway = new PrivateGateway(
    clusterUrl
      ? createHttpMxeClient(clusterUrl)
      : facilitatorForGateway
        ? createDelegatingMxe('facilitator-backed', async ({ payload, leg }) =>
            (await facilitatorForGateway.verify(payload, leg)).isValid,
          )
        : createMockMxe(),
    privacyConfig,
  );
  const paymentRecords = new PaymentRecordStore(eventLog, privacyConfig.recording);

  // 区分B の口。env が無ければ mock / 未接続のまま（偽の応答は作らない）。
  const adapters = createAdapterRegistry({
    facilitatorUrl: env.get('NA_X402_FACILITATOR_URL'),
    mxeUrl: clusterUrl,
    chainRpcUrl: env.get('NA_BASE_RPC_URL'),
    erc8004Registry: identityConfig.external_assets.registries.erc8004.find((r) => r.chain === 'base'),
    forceMock: env.get('NA_X402_MOCK') === '1',
  });

  // verified:true には証拠を要求する。実装が終わったからという理由では上がらない。
  const evidence = loadVerificationEvidence(process.env).value;
  assertVerifiedHasEvidence({
    flags: collectVerifiedFlags({ identity: identityConfig, x402: x402Config, privacy: privacyConfig }),
    evidence,
  });

  // 402 でゲートする側。既定は無効（NA_X402_PAYWALL=1 で有効）。
  const facilitatorClient = facilitatorUrl ? new FacilitatorClient(facilitatorUrl) : null;
  const paywallRequested = env.get('NA_X402_PAYWALL') === '1';
  if (paywallRequested && (!facilitatorClient || gatewayMode === 'mock')) {
    // 検証も settle もできない状態でゲートを開けない（払っていない相手を通さない）。
    throw new Error(
      'NA_X402_PAYWALL=1 だが検証・settle の相手がいない。NA_X402_FACILITATOR_URL か NA_ARCIUM_CLUSTER_URL を設定する',
    );
  }
  const paywall = new Paywall({
    config: x402Config,
    railId: 'solana',
    feePayer: new FeePayerResolver(x402Config, facilitatorClient),
    facilitator: facilitatorClient,
    gateway,
    enabled: paywallRequested,
  });

  const commissionConfig = loadCommissionConfig(process.env).value;
  const board = new CommissionBoard({
    config: commissionConfig,
    world: config,
    identity,
    log: eventLog,
    paymentRecords,
  });
  const storefront = new GoodsStorefront({ world: config, sim, log: eventLog });

  const agentConfig = loadAgentConfig(process.env).value;
  const agentGate = evaluateGates(agentConfig, loadMeasurement(agentConfig.run.measurementPath));

  return {
    config,
    configPath: path,
    env,
    sim,
    seedInput,
    marketStructure,
    renderConfig,
    identityConfig,
    roomsConfig,
    identity,
    eventLog,
    x402Config,
    x402,
    paywall,
    privacyConfig,
    evidence,
    gateway,
    paymentRecords,
    gatewayMode,
    adapters,
    agentConfig,
    agentGate,
    commissionConfig,
    board,
    storefront,
    localPlayerId: localPlayer.id,
  };
}

/** 未確定・仮値の状態を起動のたびに出す。黙って確定扱いにしない。 */
export function printStartupLabels(runtime: Runtime): void {
  const pendingNames = unconfirmedNames(runtime.config);
  console.log(`[world] config: ${runtime.configPath}`);
  console.log(`[world] 未確定の固有名: ${pendingNames.length > 0 ? pendingNames.join(', ') : 'なし'}`);
  console.log(
    `[render] mode=${runtime.renderConfig.mode} / post=${runtime.renderConfig.postprocess.passes
      .filter((p) => p.enabled && p.strength > 0)
      .map((p) => p.id)
      .join(',') || 'なし'}`,
  );
  console.log(
    `[render] 未確定（仮値のまま動かす）: ${unconfirmedPresentation(runtime.renderConfig).join(', ') || 'なし'}`,
  );
  console.log(
    `[render] 値の熟度: ${runtime.renderConfig.tuning.status}` +
      (runtime.renderConfig.tuning.status === 'first-pass' ? '（要調整・確定は加藤さん）' : ''),
  );
  console.log(`[market] seed: ${runtime.seedInput} -> ${runtime.sim.seed}`);
  console.log(`[market] 仮値: ${TUNING_PROVISIONAL_NOTE}`);
  console.log(
    `[market] 連関 ${runtime.marketStructure.links.edges.length} 本（仮）/ ` +
      `ショック伝播 ${runtime.marketStructure.shockPropagation.enabled ? '有効' : '無効'}（最大 ${runtime.marketStructure.shockPropagation.maxHops} ホップ）/ ` +
      `1 カテゴリ ${runtime.marketStructure.stalls.perCategory} 軒`,
  );
  console.log(
    `[env] 後続で必要になるキー: ${runtime.env.pending
      .map((p) => `${p.key}(${p.requiredFrom}${p.provisional ? ',キー名仮' : ''}:${p.set ? '設定済' : '未設定'})`)
      .join(', ')}`,
  );
  if (!runtime.config.economy.commission_flow.confirmed) {
    console.log('[economy] commission_flow は未確定');
  }
  console.log(
    `[identity] 外部資産は確定値・実照会は未検証（区分B）: ` +
      runtime.identityConfig.external_assets.erc8004.map((e) => `${e.chain}#${e.agentId}`).join(', '),
  );
  console.log(
    `[identity] standing しきい値は仮値（room gate: ` +
      runtime.roomsConfig.rooms.map((r) => `${r.id}>=${r.minStanding}`).join(', ') + '）',
  );
  console.log('[identity] 認証は未実装。ローカルの単一 session identity で通す（仮）');
  console.log(
    `[x402] v${runtime.x402Config.protocol.x402Version} ${runtime.x402Config.protocol.scheme} / ` +
      `facilitator ${runtime.x402Config.facilitator.url}（未検証・区分B）`,
  );
  console.log(
    `[x402] rails: ` +
      runtime.x402Config.rails
        .map((r) => `${r.id}(${r.confirmed ? '確定' : 'TBD'}/${r.verified ? '検証済' : '未検証'})`)
        .join(', ') + ` / 署名 mode=${runtime.x402.mode}`,
  );
  console.log('[x402] feePayer は 402 の /supported から動的取得（config に持たない）');
  console.log(
    `[x402] 資源のゲート: ${runtime.paywall.enabled ? '有効（commission settle / storefront buy）' : '無効（NA_X402_PAYWALL=1 で有効）'}`,
  );
  console.log(
    `[privacy] gateway mode=${runtime.gatewayMode}（実 MXE 投入は未検証・区分B） / ` +
      `返るのは ${runtime.privacyConfig.response.allowedFields.join(', ')} のみ`,
  );
  console.log(`[privacy] ${runtime.privacyConfig.claims.claim_ja}`);
  const verification = verificationSummary({
    flags: collectVerifiedFlags({
      identity: runtime.identityConfig,
      x402: runtime.x402Config,
      privacy: runtime.privacyConfig,
    }),
    evidence: runtime.evidence,
  });
  console.log(
    `[区分B] 実確認 ${verification.verified}/${verification.total}` +
      (verification.pending.length > 0 ? ` / 未消化: ${verification.pending.join(', ')}` : ''),
  );
  console.log(
    `[adapters] ${runtime.adapters
      .statuses()
      .map((a) => `${a.id}(${a.mode}${a.verified ? '' : '/未検証'})`)
      .join(', ')}`,
  );
  console.log(
    `[agent] models: quoting=${runtime.agentConfig.models.quoting} / judgement=${runtime.agentConfig.models.judgement} ` +
      `/ escalation=${runtime.agentConfig.models.escalation}（opus 全採用にしない）`,
  );
  console.log(
    `[agent] 稼働前ゲート: ${runtime.agentGate.satisfied ? '充足' : '未達'}` +
      (runtime.agentGate.satisfied
        ? ''
        : ` — ${runtime.agentGate.blockers.map((b) => b.id).join(', ')}（schedule では回さない）`),
  );
  console.log(
    `[commission] 主 ${runtime.commissionConfig.modules.primary} / 副 ${runtime.commissionConfig.modules.secondary}` +
      `（commission_flow は未確定: legs=${runtime.commissionConfig.flow.legs} / ` +
      `remote=${runtime.commissionConfig.flow.remote_handling} / unit=${runtime.commissionConfig.flow.settlement_unit}）`,
  );
  console.log(
    `[agent] spend cap ${runtime.agentConfig.budget.hardCapUsd} USD / warn ${runtime.agentConfig.budget.warnAtUsd} USD / auto-reload なし`,
  );
}

export function resolveClientDist(cwd = process.cwd()): string {
  return resolve(cwd, 'packages/client/dist');
}
