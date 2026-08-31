import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentConfig, MarketState, WorldConfig } from '@na/shared';
import { SpendLedger } from './budget.js';
import type { DryRunMeasurement } from './gate.js';
import { buildPrompt, type AgentTask } from './prompt.js';
import { LocalTokenEstimator, type TokenCounter } from './tokens.js';

/**
 * 1 サイクル分のトークン量とコストを測る。LLM は呼ばない。
 * ここで測る前に schedule で回さない（ゲートが dry-run の実測を要求する）。
 *
 * 【仮値】1 回あたりの出力トークンは実測できないので想定値を置く。measurement に残す。
 */
export const ASSUMED_OUTPUT_TOKENS_PER_CALL = 320;

export interface DryRunInput {
  config: AgentConfig;
  world: WorldConfig;
  market: MarketState;
  counter?: TokenCounter;
  now?: () => number;
}

export async function runDryCycle(input: DryRunInput): Promise<DryRunMeasurement> {
  const counter = input.counter ?? new LocalTokenEstimator();
  const now = input.now ?? (() => Date.now());
  const ledger = new SpendLedger(input.config);

  // 1 サイクル = 品目ごとの quoting ＋ 委託を受けるかの judgement 1 回。
  const tasks: { task: AgentTask; question: string }[] = [
    ...input.market.items.map((item) => ({
      task: 'quoting' as const,
      question: `品目 ${item.id} の見積もりを出してください。`,
    })),
    { task: 'judgement' as const, question: 'この委託を受けるべきか判断してください。' },
  ];

  const model = input.config.models.quoting;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let prefixTokens = 0;

  for (const [index, entry] of tasks.entries()) {
    const prompt = buildPrompt({
      world: input.world,
      market: input.market,
      task: entry.task,
      question: entry.question,
      cachingEnabled: input.config.caching.enabled,
    });
    const total = await counter.count({ model, system: prompt.system, userText: prompt.userText });
    if (index === 0) {
      const prefixOnly = await counter.count({ model, system: prompt.system, userText: '' });
      prefixTokens = prefixOnly.inputTokens;
    }
    inputTokens += total.inputTokens;
    // 2 回目以降は固定プレフィックスがキャッシュから読まれる想定。
    if (index > 0 && input.config.caching.enabled) cachedInputTokens += prefixTokens;
  }

  const outputTokens = ASSUMED_OUTPUT_TOKENS_PER_CALL * tasks.length;
  const estimatedCostUsd = ledger.cost({
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens: input.config.caching.enabled ? prefixTokens : 0,
  });

  const source = (await counter.count({ model, system: [], userText: 'x' })).source;
  return {
    at: now(),
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    estimatedCostUsd,
    source,
    calls: tasks.length,
  };
}

export function saveMeasurement(path: string, measurement: DryRunMeasurement): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(measurement, null, 2)}\n`, 'utf8');
}

/** 実測が無ければ null。ゲート側が「未実測」として扱う。 */
export function loadMeasurement(path: string): DryRunMeasurement | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DryRunMeasurement;
  } catch {
    return null;
  }
}
