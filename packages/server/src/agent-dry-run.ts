import { seedFrom } from '@na/shared';
import { loadAgentConfig } from '@na/shared/node';
import { evaluateGates } from './agent/gate.js';
import { runDryCycle, saveMeasurement } from './agent/dry-run.js';
import { createRuntime, printStartupLabels } from './runtime.js';

/**
 * M6 の dry-run。LLM を呼ばずに 1 サイクルのトークン量とコストを出し、ゲートを確認する。
 *   npm run agent:dry-run
 */
async function main(): Promise<void> {
  const runtime = createRuntime();
  printStartupLabels(runtime);
  const agentConfig = loadAgentConfig(process.env).value;

  runtime.sim.stepMany(20);
  const measurement = await runDryCycle({
    config: agentConfig,
    world: runtime.config,
    market: runtime.sim.state(Date.now()),
  });
  saveMeasurement(agentConfig.run.measurementPath, measurement);

  console.log('');
  console.log('[agent] dry-run（LLM 呼び出し 0）');
  console.log(`  model            : ${measurement.model}`);
  console.log(`  calls / cycle    : ${measurement.calls}`);
  console.log(`  input tokens     : ${measurement.inputTokens}（うちキャッシュ読み ${measurement.cachedInputTokens}）`);
  console.log(`  output tokens    : ${measurement.outputTokens}（仮値の想定値）`);
  console.log(`  cost / cycle     : ${measurement.estimatedCostUsd.toFixed(6)} USD`);
  console.log(`  source           : ${measurement.source}${measurement.source === 'local-estimate' ? '（概算・未検証）' : ''}`);
  console.log(`  hard cap         : ${agentConfig.budget.hardCapUsd} USD`);
  console.log(`  saved            : ${agentConfig.run.measurementPath}`);

  const gate = evaluateGates(agentConfig, measurement);
  console.log('');
  console.log('[agent] 稼働前ゲート');
  for (const check of gate.checked) console.log(`  ${check.ok ? 'ok  ' : 'NG  '} ${check.id}`);
  if (!gate.satisfied) {
    console.log('');
    console.log('[agent] 未達のため schedule では回さない:');
    for (const blocker of gate.blockers) console.log(`  - [${blocker.id}] ${blocker.detail}`);
  }
  console.log(`[agent] seed=${seedFrom(runtime.seedInput)} / LLM 呼び出し 0 / 課金 0`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
