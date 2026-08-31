import type { AgentConfig, ModelPricing } from '@na/shared';

/**
 * 実数のハードキャップ。超えたら止める。auto-reload はしない。
 * 通知は hook 経由。黙って走り続けさせない。
 */

export interface SpendEntry {
  at: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  note: string;
}

export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(readonly spentUsd: number, readonly capUsd: number, readonly wouldAddUsd: number) {
    super(
      `spend limit に達している: 使用 ${spentUsd.toFixed(4)} USD + 今回 ${wouldAddUsd.toFixed(4)} USD > キャップ ${capUsd} USD。` +
        'auto-reload はしない',
    );
  }
}

export interface BudgetNotice {
  kind: 'warn' | 'stop';
  spentUsd: number;
  capUsd: number;
}

export class SpendLedger {
  private readonly entries: SpendEntry[] = [];
  private warned = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly notify: (notice: BudgetNotice) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  get spentUsd(): number {
    return this.entries.reduce((sum, e) => sum + e.costUsd, 0);
  }

  get history(): SpendEntry[] {
    return [...this.entries];
  }

  pricingFor(model: string): ModelPricing {
    const pricing = this.config.pricing.perModel[model];
    if (!pricing) throw new Error(`料金が config に無いモデル: ${model}`);
    return pricing;
  }

  /** 入力・出力・キャッシュ読みを分けて計算する。単位は USD。 */
  cost(input: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  }): number {
    const p = this.pricingFor(input.model);
    const cached = input.cachedInputTokens ?? 0;
    const written = input.cacheWriteTokens ?? 0;
    const fresh = Math.max(0, input.inputTokens - cached);
    const perToken = (usdPerMillion: number, tokens: number): number => (usdPerMillion * tokens) / 1_000_000;
    return (
      perToken(p.input, fresh) +
      perToken(p.input * p.cacheReadMultiplier, cached) +
      perToken(p.input * p.cacheWriteMultiplier, written) +
      perToken(p.output, input.outputTokens)
    );
  }

  /** 実行前に必ず通す。超えるなら実行させない。 */
  assertWithin(costUsd: number): void {
    const next = this.spentUsd + costUsd;
    if (next > this.config.budget.hardCapUsd) {
      if (this.config.budget.notify) {
        this.notify({ kind: 'stop', spentUsd: this.spentUsd, capUsd: this.config.budget.hardCapUsd });
      }
      throw new BudgetExceededError(this.spentUsd, this.config.budget.hardCapUsd, costUsd);
    }
  }

  record(entry: Omit<SpendEntry, 'at' | 'costUsd'> & { costUsd?: number }): SpendEntry {
    const costUsd = entry.costUsd ?? this.cost(entry);
    this.assertWithin(costUsd);
    const stored: SpendEntry = { ...entry, costUsd, at: this.now() };
    this.entries.push(stored);
    if (!this.warned && this.spentUsd >= this.config.budget.warnAtUsd && this.config.budget.notify) {
      this.warned = true;
      this.notify({ kind: 'warn', spentUsd: this.spentUsd, capUsd: this.config.budget.hardCapUsd });
    }
    return stored;
  }
}
