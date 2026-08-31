import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig, MarketState, WorldConfig } from '@na/shared';
import { SpendLedger } from './budget.js';
import { buildPrompt, type AgentTask } from './prompt.js';

/**
 * LLM を呼ぶのは「本当に推論が要る判断」だけ。
 * 市場の動き自体は M1 の決定論で回る（ここでは価格を予測させない）。
 *
 * - モデルは config（Haiku / Sonnet）。opus 全採用にしない。
 * - 固定プレフィックスに cache_control を置き、可変は messages 側。
 * - 応答が JSON として読めなければ落とす（もっともらしい既定値で埋めない）。
 * - 実 API 呼び出しは区分B。この sandbox では dry-run のみ。
 */

export interface QuoteDecision {
  itemId: string;
  unitPrice: number;
  quantity: number;
  confidence: number;
  reason: string;
}

export interface JudgementDecision {
  action: 'accept' | 'decline' | 'escalate';
  confidence: number;
  reason: string;
}

export interface BrainOptions {
  config: AgentConfig;
  world: WorldConfig;
  ledger: SpendLedger;
  client?: Anthropic;
  /** 想定より大きい出力でコストが跳ねないようにする。 */
  maxTokens?: number;
}

export class AgentBrain {
  private readonly client: Anthropic | null;

  constructor(private readonly options: BrainOptions) {
    this.client = options.client ?? null;
  }

  modelFor(task: AgentTask): string {
    return task === 'quoting' ? this.options.config.models.quoting : this.options.config.models.judgement;
  }

  /** 実行前に見積もりコストでキャップを確認し、超えるなら呼ばない。 */
  async decide<T>(input: {
    task: AgentTask;
    market: MarketState;
    question: string;
    expectedOutputTokens?: number;
  }): Promise<{ decision: T; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }> {
    if (!this.client) {
      throw new Error(
        'LLM クライアントが無い（API キー未設定）。実呼び出しは区分B。dry-run は runDryCycle を使う',
      );
    }
    const model = this.modelFor(input.task);
    const prompt = buildPrompt({
      world: this.options.world,
      market: input.market,
      task: input.task,
      question: input.question,
      cachingEnabled: this.options.config.caching.enabled,
    });

    const maxTokens = this.options.maxTokens ?? 1024;
    // 事前見積もり。実際の使用量は応答後に記録し直す。
    this.options.ledger.assertWithin(
      this.options.ledger.cost({
        model,
        inputTokens: this.options.config.cadence.maxInputTokensPerCall ?? 4000,
        outputTokens: maxTokens,
      }),
    );

    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      system: prompt.system as Anthropic.TextBlockParam[],
      messages: [{ role: 'user', content: prompt.userText }],
    });

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    this.options.ledger.record({
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      note: input.task,
    });

    if (this.options.config.caching.requireCacheHit && usage.cachedInputTokens === 0) {
      // 黙って見逃すとキャッシュが効いていないまま課金が続く。
      console.warn(
        '[agent] prompt cache が効いていない（cache_read_input_tokens = 0）。固定プレフィックスに可変値が混ざっていないか確認する',
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return { decision: parseJson<T>(text), usage };
  }
}

/** JSON として読めなければ落とす。既定値で埋めない。 */
export function parseJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch (cause) {
    throw new Error(
      `モデルの応答を JSON として読めない: ${(cause as Error).message} / 先頭 200 文字: ${trimmed.slice(0, 200)}`,
    );
  }
}
