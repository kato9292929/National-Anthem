import { collectVerifiedFlags, unconfirmedPresentation, verificationSummary } from '@na/shared';
import { runCommissionAction } from './commission/actions.js';
import { createHttpServer } from './http.js';
import { createRuntime, printStartupLabels, resolveAssetsDir, resolveClientDist } from './runtime.js';

/** tick の実時間間隔【仮値】。市場が勝手に動く速さ。 */
const TICK_INTERVAL_MS = 1000;

function main(): void {
  const runtime = createRuntime();
  printStartupLabels(runtime);

  const port = Number(runtime.env.get('NA_SERVER_PORT'));
  const serveClient = runtime.env.get('NA_SERVE_CLIENT') === '1';
  const clientDist = serveClient ? resolveClientDist() : undefined;
  const assetsDir = serveClient ? resolveAssetsDir() : undefined;

  const server = createHttpServer({
    config: runtime.config,
    configPath: runtime.configPath,
    sim: runtime.sim,
    identity: runtime.identity,
    roomsConfig: runtime.roomsConfig,
    localPlayerId: runtime.localPlayerId,
    paywall: {
      enabled: runtime.paywall.enabled,
      headerName: runtime.x402Config.protocol.paymentHeader,
      guard: (input) => runtime.paywall.guard(input),
    },
    x402Status: () => runtime.x402.status(),
    commissionBoard: () => ({
      modules: runtime.commissionConfig.modules,
      flow: runtime.commissionConfig.flow,
      escrow: { unit: runtime.commissionConfig.escrow.unit, confirmed: runtime.commissionConfig.escrow.confirmed },
      commissions: runtime.board.list().map((commission) => ({
        ...commission,
        escrow: runtime.board.escrow.get(commission.id),
        dispute: runtime.board.disputeFor(commission.id),
      })),
      notes: {
        center: '経済の重心は交易代理＋記録。物販は副モジュール',
        flow: 'legs / remote_handling / settlement_unit は未確定。委託は provisional で回る',
        settlement: '精算は封印精算（Gateway 経由）。返るのは payment_valid のみ',
      },
    }),
    commissionAction: (body) =>
      runCommissionAction({
        board: runtime.board,
        gateway: runtime.gateway,
        localPlayerId: runtime.localPlayerId,
        body,
      }),
    storefrontListing: () => ({
      rank: runtime.storefront.rank,
      subordinateTo: runtime.storefront.subordinateTo,
      items: runtime.storefront.listing(),
    }),
    storefrontBuy: (body) =>
      runtime.storefront.buy({
        buyerId: String(body['buyerId'] ?? runtime.localPlayerId),
        itemId: String(body['itemId'] ?? ''),
        quantity: Number(body['quantity'] ?? 1),
      }),
    agentStatus: () => ({
      models: runtime.agentConfig.models,
      caching: runtime.agentConfig.caching,
      cadence: runtime.agentConfig.cadence,
      budget: runtime.agentConfig.budget,
      pricing: { as_of: runtime.agentConfig.pricing.as_of, verified: runtime.agentConfig.pricing.verified },
      gate: runtime.agentGate,
      notes: {
        scheduling: runtime.agentGate.satisfied
          ? '稼働前ゲートは充足。schedule に載せられる'
          : '稼働前ゲート未達のため schedule では回さない',
        dryRun: 'npm run agent:dry-run で 1 サイクルのトークン量とコストを測る（LLM 呼び出し 0）',
        llm: '市場の動きは M1 の決定論。LLM は推論が要る判断だけに使う',
      },
    }),
    presentationConfig: () => ({
      config: runtime.renderConfig,
      unconfirmed: unconfirmedPresentation(runtime.renderConfig),
      tuning: runtime.renderConfig.tuning,
      assets: {
        generator: runtime.assetsConfig.generator,
        license: runtime.assetsConfig.license,
        polyBudget: runtime.assetsConfig.polyBudget,
        costMeasured: runtime.assetsConfig.budget.measuredCostPerMeshUsd !== null,
        assignedMeshes: Object.entries(runtime.renderConfig.assets.meshes)
          .filter(([, m]) => m.url !== '')
          .map(([slot, m]) => ({ slot, placeholder: m.placeholder, source: m.source })),
      },
      notes: {
        scope:
          '方向（ウルの形＋Donwood の暗い質感）は確定。色・強度は一次案（要調整）で、確定は加藤さんが実参照から行う',
        swap: 'config 差し替えだけで見た目が変わる（ソース修正なし）',
        toggle: 'greybox ↔ stylized は残す。P キー、または ?render=stylized',
      },
    }),
    adapterStatus: () => ({
      verification: {
        ...verificationSummary({
          flags: collectVerifiedFlags({
            identity: runtime.identityConfig,
            x402: runtime.x402Config,
            privacy: runtime.privacyConfig,
          }),
          evidence: runtime.evidence,
        }),
        records: runtime.evidence.records.length,
        rule: 'verified:true には証拠レコードが要る。実装完了では上げない',
      },
      adapters: runtime.adapters.statuses(),
      notes: {
        scope: '実キー・実ネットワークが要る接続は区分B（加藤さん環境で消化）',
        mock: 'mock は値に mock: を残し、onChain は false。もっともらしい偽応答を作らない',
        unconfigured: '未接続の口は呼ばれたら落ちる。何が要るかをメッセージに載せる',
      },
    }),
    privacyStatus: () => ({
      gateway: { ...runtime.privacyConfig.gateway, mode: runtime.gatewayMode },
      response: runtime.privacyConfig.response,
      recording: runtime.privacyConfig.recording,
      claims: runtime.privacyConfig.claims,
      records: runtime.paymentRecords.all().length,
      notes: {
        verification: '検証は MXE の中で走り、返るのは payment_valid のみ',
        recording: 'ログ / KV にウォレットアドレス・金額・エンドポイントを残さない',
        scope: 'ミキサーは実装しない。送金の追跡不能化ではなく検証の機密化',
      },
    }),
    port,
    clientDist,
    assetsDir,
  });

  const timer = setInterval(() => runtime.sim.step(), TICK_INTERVAL_MS);
  timer.unref?.();

  server.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port} (tick ${TICK_INTERVAL_MS}ms)`);
    if (clientDist) console.log(`[server] serving client from ${clientDist}`);
  });

  const shutdown = (): void => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
