import { createHttpServer } from './http.js';
import { createRuntime, printStartupLabels, resolveClientDist } from './runtime.js';

/** tick の実時間間隔【仮値】。市場が勝手に動く速さ。 */
const TICK_INTERVAL_MS = 1000;

function main(): void {
  const runtime = createRuntime();
  printStartupLabels(runtime);

  const port = Number(runtime.env.get('NA_SERVER_PORT'));
  const serveClient = runtime.env.get('NA_SERVE_CLIENT') === '1';
  const clientDist = serveClient ? resolveClientDist() : undefined;

  const server = createHttpServer({
    config: runtime.config,
    configPath: runtime.configPath,
    sim: runtime.sim,
    identity: runtime.identity,
    roomsConfig: runtime.roomsConfig,
    localPlayerId: runtime.localPlayerId,
    x402Status: () => runtime.x402.status(),
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
