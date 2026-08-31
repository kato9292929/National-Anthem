import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentConfig } from '@na/shared';
import { seedFrom } from '@na/shared';
import { loadAgentConfig, loadWorldConfig } from '@na/shared/node';
import { parseJson } from '../agent/brain.js';
import { BudgetExceededError, SpendLedger, type BudgetNotice } from '../agent/budget.js';
import { runDryCycle } from '../agent/dry-run.js';
import { assertGatesSatisfied, evaluateGates, GateNotSatisfiedError, type DryRunMeasurement } from '../agent/gate.js';
import { buildPrompt } from '../agent/prompt.js';
import { startAgentLoop } from '../agent/scheduler.js';
import { MarketSimulation } from '../market/simulation.js';

const agentConfig = loadAgentConfig({}).value;
const world = loadWorldConfig({}).config;

function market() {
  const sim = new MarketSimulation({ config: world, seed: seedFrom('agent-test') });
  sim.stepMany(20);
  return sim.state(0);
}

function withCadence(config: AgentConfig): AgentConfig {
  return {
    ...config,
    cadence: { tickIntervalSeconds: 60, maxInputTokensPerCall: 4000, maxCallsPerTick: 8, confirmed: true },
  };
}

const measurement: DryRunMeasurement = {
  at: 0,
  model: 'claude-haiku-4-5',
  inputTokens: 2400,
  outputTokens: 2200,
  cachedInputTokens: 1100,
  estimatedCostUsd: 0.0129,
  source: 'local-estimate',
  calls: 7,
};

test('モデルは Haiku / Sonnet。opus 全採用と auto-reload は config が拒否する', () => {
  assert.equal(agentConfig.models.quoting, 'claude-haiku-4-5');
  assert.equal(agentConfig.models.judgement, 'claude-haiku-4-5');
  assert.equal(agentConfig.models.escalation, 'claude-sonnet-5');
  assert.equal(agentConfig.models.opusAllowed, false);
  assert.equal(agentConfig.budget.autoReload, false);
  assert.equal(agentConfig.pricing.verified, false, '料金は変わるので未検証扱い');
});

test('tick 頻度と 1 回あたり入力トークンが未確定の間はゲートが開かない', () => {
  const gate = evaluateGates(agentConfig, measurement);
  assert.equal(gate.satisfied, false);
  assert.deepEqual(gate.blockers.map((b) => b.id), ['cadence']);
  assert.throws(() => assertGatesSatisfied(agentConfig, measurement), (error: unknown) => {
    assert.ok(error instanceof GateNotSatisfiedError);
    assert.match(error.message, /schedule で回さない/);
    return true;
  });
});

test('dry-run の実測が無ければゲートが開かない', () => {
  const gate = evaluateGates(withCadence(agentConfig), null);
  assert.equal(gate.satisfied, false);
  assert.deepEqual(gate.blockers.map((b) => b.id), ['dry-run']);
});

test('5 条件＋実測が揃えばゲートが開く', () => {
  const gate = evaluateGates(withCadence(agentConfig), measurement);
  assert.equal(gate.satisfied, true, gate.blockers.map((b) => b.id).join(','));
  assert.deepEqual(
    gate.checked.map((c) => c.id),
    ['models', 'prompt-caching', 'cadence', 'spend-cap', 'auto-reload', 'dry-run', 'dry-run-within-cap', 'dry-run-input-budget'],
  );
});

test('opus を判定に据えるとゲートが閉じる', () => {
  const config = withCadence(agentConfig);
  const gate = evaluateGates(
    { ...config, models: { ...config.models, judgement: 'claude-opus-5' } },
    measurement,
  );
  assert.equal(gate.satisfied, false);
  assert.ok(gate.blockers.some((b) => b.id === 'models'));
});

test('1 サイクルの実測がキャップを超えていればゲートが閉じる', () => {
  const gate = evaluateGates(withCadence(agentConfig), { ...measurement, estimatedCostUsd: 99 });
  assert.ok(gate.blockers.some((b) => b.id === 'dry-run-within-cap'));
});

test('コスト計算: 入力・出力・キャッシュ読みを分けて数える', () => {
  const ledger = new SpendLedger(agentConfig);
  // Haiku 4.5: 入力 $1 / 出力 $5 per 1M
  assert.equal(ledger.cost({ model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 0 }), 1);
  assert.equal(ledger.cost({ model: 'claude-haiku-4-5', inputTokens: 0, outputTokens: 1_000_000 }), 5);
  // キャッシュ読みは 0.1 倍
  assert.equal(
    ledger.cost({ model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }),
    0.1,
  );
  assert.throws(() => ledger.cost({ model: 'claude-unknown', inputTokens: 1, outputTokens: 1 }), /料金が config に無い/);
});

test('ハードキャップを超える実行は止まる。auto-reload はしない', () => {
  const notices: BudgetNotice[] = [];
  const ledger = new SpendLedger(agentConfig, (n) => notices.push(n));
  ledger.record({ model: 'claude-haiku-4-5', inputTokens: 3_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, note: 'test' });
  assert.equal(notices.filter((n) => n.kind === 'warn').length, 1, 'warn しきい値で通知する');
  assert.throws(
    () =>
      ledger.record({ model: 'claude-haiku-4-5', inputTokens: 9_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, note: 'over' }),
    (error: unknown) => {
      assert.ok(error instanceof BudgetExceededError);
      assert.match(error.message, /auto-reload はしない/);
      return true;
    },
  );
  assert.equal(notices.filter((n) => n.kind === 'stop').length, 1);
});

test('prompt は固定プレフィックス → 可変の順。固定側に可変値を混ぜない', () => {
  const state = market();
  const prompt = buildPrompt({ world, market: state, task: 'quoting', question: 'q', cachingEnabled: true });
  const prefix = prompt.system[0]!;
  assert.equal(prefix.cache_control?.type, 'ephemeral');
  assert.ok(prefix.text.includes(world.stall_categories.imports[0]!.id), '品目は config 由来');
  assert.ok(!prefix.text.includes(`tick ${state.tick}`), '固定側に tick を混ぜない');
  assert.ok(!/price=/.test(prefix.text), '固定側に価格を混ぜない');
  assert.ok(prompt.userText.includes(`tick ${state.tick}`), '可変側に現在の市場が入る');
  assert.ok(/price=/.test(prompt.userText));

  // 市場が動いても固定プレフィックスは 1 バイトも変わらない（キャッシュが効く条件）。
  const sim = new MarketSimulation({ config: world, seed: seedFrom('agent-test') });
  sim.stepMany(200);
  const later = buildPrompt({ world, market: sim.state(0), task: 'quoting', question: 'q', cachingEnabled: true });
  assert.equal(later.system[0]!.text, prefix.text);
});

test('dry-run が 1 サイクルのトークン量とコストを出す（LLM 呼び出し 0）', async () => {
  const result = await runDryCycle({ config: agentConfig, world, market: market() });
  assert.equal(result.source, 'local-estimate');
  assert.ok(result.calls > 1);
  assert.ok(result.inputTokens > 0);
  assert.ok(result.cachedInputTokens > 0, '2 回目以降は固定プレフィックスがキャッシュから読まれる想定');
  assert.ok(result.estimatedCostUsd > 0);
  assert.ok(result.estimatedCostUsd < agentConfig.budget.hardCapUsd);
});

test('モデルの応答が JSON でなければ既定値で埋めずに落ちる', () => {
  assert.deepEqual(parseJson<{ a: number }>('{"a":1}'), { a: 1 });
  assert.throws(() => parseJson('これは JSON ではありません'), /JSON として読めない/);
});

test('ゲート未達なら schedule に載せられない', () => {
  assert.throws(
    () => startAgentLoop({ config: agentConfig, measurement, onTick: () => {} }),
    (error: unknown) => {
      assert.ok(error instanceof GateNotSatisfiedError);
      return true;
    },
  );
});

test('ゲートを満たせば schedule に載る（確定した tick 頻度で回る）', () => {
  let ticks = 0;
  const handle = startAgentLoop({
    config: withCadence(agentConfig),
    measurement,
    onTick: () => {
      ticks += 1;
    },
    setIntervalImpl: ((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
  });
  assert.equal(handle.tickIntervalSeconds, 60);
  assert.equal(ticks, 1);
  handle.stop();
});
