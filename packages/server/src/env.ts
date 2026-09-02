import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvError } from '@na/shared';

/**
 * env / secrets の枠。
 * 未設定を既定値で埋めて先に進まない。必須が欠けたら明示して落ちる。
 * 後続マイルストーンのキーは「まだ必須でない」ことを明示したうえで一覧に残す。
 */

export const CURRENT_MILESTONE = 'M2' as const;

const MILESTONE_ORDER = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] as const;
export type Milestone = (typeof MILESTONE_ORDER)[number];

export interface EnvSpec {
  key: string;
  description: string;
  /** このマイルストーン以降で必須になる。 */
  requiredFrom: Milestone;
  /** true = キー名自体が仮。確定したら差し替える。 */
  provisional: boolean;
  secret: boolean;
  example: string;
  /** 任意項目の既定値。必須項目には置かない（推測で埋めないため）。 */
  fallback?: string;
}

export const ENV_SPECS: EnvSpec[] = [
  {
    key: 'NA_MARKET_SEED',
    description: '市場シムのシード。同じ値なら同じ市場が再現する。',
    requiredFrom: 'M1',
    provisional: false,
    secret: false,
    example: 'na-v0-0001',
  },
  {
    key: 'NA_SERVER_PORT',
    description: 'サーバの待受ポート。',
    requiredFrom: 'M7',
    provisional: false,
    secret: false,
    example: '8787',
    fallback: '8787',
  },
  {
    key: 'NA_WORLD_CONFIG',
    description: 'world.config.json のパス上書き。未指定ならリポジトリ内の既定位置。',
    requiredFrom: 'M7',
    provisional: false,
    secret: false,
    example: 'world/world.config.json',
  },
  {
    key: 'NA_SERVE_CLIENT',
    description: '1 で packages/client/dist を同一オリジンで配信する（スモーク検証用）。',
    requiredFrom: 'M7',
    provisional: false,
    secret: false,
    example: '0',
    fallback: '0',
  },
  {
    key: 'NA_DATA_DIR',
    description: 'identity / 評判の永続化先。未指定ならメモリのみ（プロセス終了で消える）。',
    requiredFrom: 'M7',
    provisional: false,
    secret: false,
    example: 'var',
  },
  {
    key: 'NA_X402_MOCK',
    description: '1 で x402 の mock 署名口を使う（区分A の検証用）。実署名は未実装。',
    requiredFrom: 'M7',
    provisional: false,
    secret: false,
    example: '0',
    fallback: '0',
  },
  {
    key: 'NA_X402_PAYWALL',
    description: '1 で自分のエンドポイント（commission 精算・物販購入）を 402 でゲートする。実 facilitator が要る。',
    requiredFrom: 'M7',
    provisional: false,
    secret: false,
    example: '0',
    fallback: '0',
  },
  {
    key: 'NA_SOLANA_PRIVATE_KEY',
    description: '[区分B] Solana の署名鍵（base58 の 64 byte keypair）。公式 SDK に渡す。',
    requiredFrom: 'M4',
    provisional: false,
    secret: true,
    example: '',
  },
  {
    key: 'NA_EVM_PRIVATE_KEY',
    description: '[区分B] Base の署名鍵（0x…）。Circle DCW を使う場合は不要。',
    requiredFrom: 'M4',
    provisional: false,
    secret: true,
    example: '',
  },
  {
    key: 'NA_CIRCLE_API_KEY',
    description: '[区分B] Circle DCW の API キー（sign/typedData 用）。',
    requiredFrom: 'M4',
    provisional: false,
    secret: true,
    example: '',
  },
  {
    key: 'NA_CIRCLE_EVM_WALLET_ID',
    description: '[区分B] Circle DCW の walletId（EVM）。',
    requiredFrom: 'M4',
    provisional: false,
    secret: false,
    example: '',
  },
  {
    key: 'NA_CIRCLE_EVM_WALLET_ADDRESS',
    description: '[区分B] Circle DCW のアドレス（EVM）。',
    requiredFrom: 'M4',
    provisional: false,
    secret: false,
    example: '',
  },
  {
    key: 'NA_BASE_RPC_URL',
    description: '[区分B] Base の RPC。ERC-8004 レジストリ照会に使う。',
    requiredFrom: 'M3',
    provisional: false,
    secret: false,
    example: '',
  },
  {
    key: 'NA_ARCIUM_MXE_ID',
    description: '[区分B] Arcium の MXE id。実計算の呼び出し形は未実装（Arcium 側も real path 未実装）。',
    requiredFrom: 'M5',
    provisional: true,
    secret: false,
    example: '',
  },
  {
    key: 'NA_WALLET_PRIVATE_KEY',
    description: '[区分B] 旧称。NA_SOLANA_PRIVATE_KEY の別名として読む。',
    requiredFrom: 'M4',
    provisional: true,
    secret: true,
    example: '',
  },
  {
    key: 'NA_X402_FACILITATOR_URL',
    description: '[M4 x402 決済] 未着手。キー名は仮。',
    requiredFrom: 'M4',
    provisional: true,
    secret: false,
    example: '',
  },
  {
    key: 'NA_ARCIUM_CLUSTER_URL',
    description: '[M5 Arcium MXE] 未着手。キー名は仮。',
    requiredFrom: 'M5',
    provisional: true,
    secret: false,
    example: '',
  },
  {
    key: 'NA_LLM_API_KEY',
    description: '[M6 エージェント自律] 未着手。キー名は仮。M0〜M2 では一切呼ばない。',
    requiredFrom: 'M6',
    provisional: true,
    secret: true,
    example: '',
  },
];

function rank(m: Milestone): number {
  return MILESTONE_ORDER.indexOf(m);
}

export function isRequiredNow(spec: EnvSpec, milestone: Milestone = CURRENT_MILESTONE): boolean {
  return rank(spec.requiredFrom) <= rank(milestone);
}

/** .env を読む。既に process.env にある値は上書きしない。依存を足さないための最小実装。 */
export function loadDotEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = join(cwd, '.env');
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
  return path;
}

export interface ResolvedEnv {
  get(key: string): string | undefined;
  require(key: string): string;
  /** まだ必須でないキーの状態。起動ログに出す。 */
  pending: { key: string; requiredFrom: Milestone; provisional: boolean; set: boolean }[];
}

/**
 * 必須 env を検証する。欠けていたら EnvError で停止（握りつぶさない）。
 */
export function resolveEnv(
  env: NodeJS.ProcessEnv = process.env,
  milestone: Milestone = CURRENT_MILESTONE,
): ResolvedEnv {
  const missing: EnvSpec[] = [];
  const values = new Map<string, string>();

  for (const spec of ENV_SPECS) {
    const raw = env[spec.key];
    const present = raw !== undefined && raw !== '';
    if (present) {
      values.set(spec.key, raw);
      continue;
    }
    if (isRequiredNow(spec, milestone)) {
      if (spec.fallback !== undefined) {
        values.set(spec.key, spec.fallback);
      } else {
        missing.push(spec);
      }
      continue;
    }
    if (spec.fallback !== undefined) values.set(spec.key, spec.fallback);
  }

  if (missing.length > 0) {
    const lines = missing.map(
      (s) => `  - ${s.key}${s.secret ? '（secret）' : ''}: 未設定 — ${s.description}（例: ${s.example}）`,
    );
    throw new EnvError(
      [
        `必須の環境変数が未設定（マイルストーン ${milestone}）:`,
        ...lines,
        '',
        '.env.example をコピーして .env を作る: cp .env.example .env',
      ].join('\n'),
    );
  }

  const pending = ENV_SPECS.filter((s) => !isRequiredNow(s, milestone)).map((s) => ({
    key: s.key,
    requiredFrom: s.requiredFrom,
    provisional: s.provisional,
    set: env[s.key] !== undefined && env[s.key] !== '',
  }));

  return {
    get: (key) => values.get(key),
    require: (key) => {
      const v = values.get(key);
      if (v === undefined) throw new EnvError(`環境変数 ${key} が未設定（require で参照された）`);
      return v;
    },
    pending,
  };
}
