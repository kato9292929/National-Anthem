import type { AgentConfig } from '@na/shared';

/**
 * M6 の稼働前ゲート。ここを満たすまで schedule で回さない。
 * (1) モデル: 判定・quoting は Haiku / Sonnet から。opus 全採用にしない
 * (2) prompt caching: 固定プレフィックス＋可変の順
 * (3) tick 頻度と 1 回あたり入力トークン量の確定
 * (4) spend limit の実数ハードキャップ＋通知
 * (5) auto-reload を垂れ流しにしない
 * さらに、dry-run の実測が済んでいること。
 */

export interface DryRunMeasurement {
  at: number;
  model: string;
  /** 1 サイクル分。 */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedCostUsd: number;
  /** 実 API で数えたか、ローカル概算か。概算なら未検証。 */
  source: 'api-count-tokens' | 'local-estimate';
  calls: number;
}

export interface GateResult {
  satisfied: boolean;
  blockers: { id: string; detail: string }[];
  checked: { id: string; ok: boolean }[];
}

const ALLOWED_MODEL_PREFIXES = ['claude-haiku', 'claude-sonnet'];

export function evaluateGates(config: AgentConfig, measurement: DryRunMeasurement | null): GateResult {
  const blockers: { id: string; detail: string }[] = [];
  const checked: { id: string; ok: boolean }[] = [];

  const add = (id: string, ok: boolean, detail: string): void => {
    checked.push({ id, ok });
    if (!ok) blockers.push({ id, detail });
  };

  const models = [config.models.quoting, config.models.judgement, config.models.escalation];
  add(
    'models',
    !config.models.opusAllowed && models.every((m) => ALLOWED_MODEL_PREFIXES.some((p) => m.startsWith(p))),
    `判定・quoting は Haiku / Sonnet から（現在: ${models.join(', ')}）`,
  );

  add(
    'prompt-caching',
    config.caching.enabled && config.caching.breakpoint === 'system-prefix',
    '固定プレフィックス（system）→ 可変（messages）の順で prompt caching を有効にする',
  );

  const cadenceReady =
    config.cadence.confirmed &&
    config.cadence.tickIntervalSeconds !== null &&
    config.cadence.maxInputTokensPerCall !== null &&
    config.cadence.maxCallsPerTick !== null;
  add(
    'cadence',
    cadenceReady,
    'tick 頻度と 1 回あたり入力トークン量が未確定（config/agent.config.json の cadence）',
  );

  add(
    'spend-cap',
    config.budget.hardCapUsd > 0 && config.budget.notify && config.budget.warnAtUsd < config.budget.hardCapUsd,
    '実数のハードキャップと通知を設定する（青天井にしない）',
  );

  add('auto-reload', config.budget.autoReload === false, 'auto-reload は行わない');

  if (config.run.dryRunRequired) {
    add(
      'dry-run',
      measurement !== null,
      'dry-run で 1 サイクルのトークン量とコストを実測してから本稼働する',
    );
    if (measurement) {
      add(
        'dry-run-within-cap',
        measurement.estimatedCostUsd <= config.budget.hardCapUsd,
        `1 サイクルの実測コスト ${measurement.estimatedCostUsd.toFixed(4)} USD がキャップ ${config.budget.hardCapUsd} USD を超えている`,
      );
      if (config.cadence.maxInputTokensPerCall !== null) {
        add(
          'dry-run-input-budget',
          measurement.inputTokens / Math.max(measurement.calls, 1) <= config.cadence.maxInputTokensPerCall,
          `1 回あたり入力トークンが上限 ${config.cadence.maxInputTokensPerCall} を超えている`,
        );
      }
    }
  }

  return { satisfied: blockers.length === 0, blockers, checked };
}

export class GateNotSatisfiedError extends Error {
  override readonly name = 'GateNotSatisfiedError';
  constructor(readonly result: GateResult) {
    super(
      '稼働前ゲートを満たしていないので schedule で回さない:\n' +
        result.blockers.map((b) => `  - [${b.id}] ${b.detail}`).join('\n'),
    );
  }
}

/** schedule に載せる前に必ず通る関門。 */
export function assertGatesSatisfied(config: AgentConfig, measurement: DryRunMeasurement | null): void {
  const result = evaluateGates(config, measurement);
  if (!result.satisfied) throw new GateNotSatisfiedError(result);
}
