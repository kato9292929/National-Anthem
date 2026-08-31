import type { NamedValue, NamingKey, WorldConfig } from './world-config.types.js';

/** 未確定であることを示す UI ラベル。固有名ではないのでソースに置いてよい。 */
export const UNCONFIRMED_LABEL = '未確定';

export interface ResolvedName {
  key: NamingKey;
  /** config の値そのまま。未確定なら仮値（MARKET_NAME 等）がそのまま入る。 */
  value: string;
  confirmed: boolean;
  /** 画面に出す文字列。未確定なら仮値であることが分かる形にする。 */
  display: string;
}

/**
 * naming.* を config から引く。ソースに固有名リテラルを書かないための唯一の入口。
 * 未確定でも停止しない（仮値＋ラベルで通す）。
 */
export function resolveName(config: WorldConfig, key: NamingKey): ResolvedName {
  const entry: NamedValue | undefined = config.naming[key];
  if (!entry) {
    throw new Error(`naming.${key} が world.config.json に無い`);
  }
  return {
    key,
    value: entry.value,
    confirmed: entry.confirmed,
    display: entry.confirmed ? entry.value : `${entry.value}（${UNCONFIRMED_LABEL}）`,
  };
}

export function resolveAllNames(config: WorldConfig): Record<NamingKey, ResolvedName> {
  const keys: NamingKey[] = ['market', 'district', 'npc', 'stall'];
  const out = {} as Record<NamingKey, ResolvedName>;
  for (const key of keys) out[key] = resolveName(config, key);
  return out;
}

/** 未確定のまま残っている naming キーの一覧。README / 起動ログに出す。 */
export function unconfirmedNames(config: WorldConfig): NamingKey[] {
  return (Object.keys(config.naming) as NamingKey[]).filter((k) => !config.naming[k].confirmed);
}
