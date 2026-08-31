import type { MarketState, WorldConfig } from '@na/shared';

/**
 * 固定プレフィックス → 可変、の順に組む。
 * 入力が出力より大きいので、固定側に cache_control を置いて使い回す。
 * 固定側に時刻・tick・乱数など可変値を混ぜない（混ぜるとキャッシュが毎回無効になる）。
 */

export interface CachedSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface AgentPrompt {
  system: CachedSystemBlock[];
  userText: string;
}

export type AgentTask = 'quoting' | 'judgement';

/**
 * 固定プレフィックス。config 由来の構造だけを載せる（固有名は入れない・可変値も入れない）。
 * 市場カテゴリは config の stall_categories から作る。
 */
export function buildFixedPrefix(world: WorldConfig, task: AgentTask): string {
  const categories = [
    ...world.stall_categories.imports.map((c) => `${c.id}(輸入)`),
    ...world.stall_categories.exports.map((c) => `${c.id}(輸出)`),
  ].join(', ');

  return [
    'あなたは古代交易都市の交易代理人（šamallum）として働くエージェントです。',
    '委託元（principal）の代わりに、市場の状態を見て判断します。',
    '',
    '# 市場の構造',
    `品目: ${categories}`,
    `経済ロジック: ${world.market_logic_ja}`,
    '価格と在庫はサーバ側の決定論で動きます。あなたはそれを予測するのではなく、与えられた状態に対して判断します。',
    '',
    '# 出力',
    task === 'quoting'
      ? '見積もりを JSON で返してください: {"itemId": string, "unitPrice": number, "quantity": number, "confidence": number, "reason": string}'
      : '判断を JSON で返してください: {"action": "accept"|"decline"|"escalate", "confidence": number, "reason": string}',
    'JSON 以外を出力しないこと。説明文を前後に付けないこと。',
  ].join('\n');
}

/** 可変部分。tick / 価格 / 在庫など、毎回変わる値はすべてこちら側に置く。 */
export function buildVariableInput(market: MarketState, question: string): string {
  const lines = market.states.map((s) => {
    const item = market.items.find((i) => i.id === s.itemId);
    return `${s.itemId}\tprice=${s.price}\tstock=${Math.round(s.stock)}\tbase=${item?.basePrice ?? '?'}\tshock=${s.shock ? s.shock.supplyMultiplier : 'none'}`;
  });
  return [`# 現在の市場（tick ${market.tick}）`, ...lines, '', `# 依頼`, question].join('\n');
}

export function buildPrompt(input: {
  world: WorldConfig;
  market: MarketState;
  task: AgentTask;
  question: string;
  cachingEnabled: boolean;
}): AgentPrompt {
  const prefix = buildFixedPrefix(input.world, input.task);
  return {
    system: [
      input.cachingEnabled
        ? { type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: prefix },
    ],
    userText: buildVariableInput(input.market, input.question),
  };
}
