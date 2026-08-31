import type Anthropic from '@anthropic-ai/sdk';
import type { CachedSystemBlock } from './prompt.js';

/**
 * トークン数の数え方は 2 通り。
 * - api-count-tokens: Messages API の count_tokens。実測（要 API キー＝区分B）。
 * - local-estimate: ローカル概算。dry-run をキー無しで回すため。【未検証】の値として扱う。
 */

export interface TokenCount {
  inputTokens: number;
  source: 'api-count-tokens' | 'local-estimate';
}

export interface TokenCounter {
  count(input: { model: string; system: CachedSystemBlock[]; userText: string }): Promise<TokenCount>;
}

/**
 * 【概算】日本語と英語の混在を 1 トークン ≒ 2.2 文字として見積もる。
 * 実測ではないので、この値だけで本稼働の判断をしない（ゲートにも source を残す）。
 */
export const LOCAL_ESTIMATE_CHARS_PER_TOKEN = 2.2;

export class LocalTokenEstimator implements TokenCounter {
  count(input: { model: string; system: CachedSystemBlock[]; userText: string }): Promise<TokenCount> {
    const text = [...input.system.map((b) => b.text), input.userText].join('\n');
    return Promise.resolve({
      inputTokens: Math.ceil(text.length / LOCAL_ESTIMATE_CHARS_PER_TOKEN),
      source: 'local-estimate',
    });
  }
}

/** 実測。API キーが要るので、この sandbox では回らない（区分B）。 */
export class ApiTokenCounter implements TokenCounter {
  constructor(private readonly client: Anthropic) {}

  async count(input: {
    model: string;
    system: CachedSystemBlock[];
    userText: string;
  }): Promise<TokenCount> {
    const response = await this.client.messages.countTokens({
      model: input.model,
      system: input.system as Anthropic.TextBlockParam[],
      messages: [{ role: 'user', content: input.userText }],
    });
    return { inputTokens: response.input_tokens, source: 'api-count-tokens' };
  }
}
