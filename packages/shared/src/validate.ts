import { ConfigError } from './errors.js';
import type {
  NamedValue,
  NamingKey,
  StallCategory,
  WorldConfig,
} from './world-config.types.js';

/**
 * world.config.json の検証。欠けていたら埋めずに落とす。
 * 推測でデフォルトを入れない（未確定は config 側で仮値＋ confirmed:false として持つ）。
 */

function fail(message: string, source: string, key?: string): never {
  throw new ConfigError(message, key === undefined ? { source } : { source, key });
}

function obj(value: unknown, source: string, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`オブジェクトである必要がある（実際: ${describe(value)}）`, source, key);
  }
  return value as Record<string, unknown>;
}

function arr(value: unknown, source: string, key: string): unknown[] {
  if (!Array.isArray(value)) fail(`配列である必要がある（実際: ${describe(value)}）`, source, key);
  return value;
}

function str(value: unknown, source: string, key: string): string {
  if (typeof value !== 'string' || value === '') {
    fail(`空でない文字列である必要がある（実際: ${describe(value)}）`, source, key);
  }
  return value;
}

function bool(value: unknown, source: string, key: string): boolean {
  if (typeof value !== 'boolean') fail(`真偽値である必要がある（実際: ${describe(value)}）`, source, key);
  return value;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined（キーが無い）';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function namedValue(value: unknown, source: string, key: string): NamedValue {
  const o = obj(value, source, key);
  return {
    value: str(o['value'], source, `${key}.value`),
    confirmed: bool(o['confirmed'], source, `${key}.confirmed`),
    owner: str(o['owner'], source, `${key}.owner`),
  };
}

function stallCategory(value: unknown, source: string, key: string): StallCategory {
  const o = obj(value, source, key);
  const sources = o['sources_ja'];
  const category: StallCategory = {
    id: str(o['id'], source, `${key}.id`),
    label_ja: str(o['label_ja'], source, `${key}.label_ja`),
  };
  if (sources !== undefined) {
    category.sources_ja = arr(sources, source, `${key}.sources_ja`).map((s, i) =>
      str(s, source, `${key}.sources_ja[${i}]`),
    );
  }
  return category;
}

const NAMING_KEYS: NamingKey[] = ['market', 'district', 'npc', 'stall'];

export function validateWorldConfig(input: unknown, source = 'world.config.json'): WorldConfig {
  const root = obj(input, source, '(root)');

  const naming = obj(root['naming'], source, 'naming');
  const resolvedNaming = {} as Record<NamingKey, NamedValue>;
  for (const key of NAMING_KEYS) {
    resolvedNaming[key] = namedValue(naming[key], source, `naming.${key}`);
  }

  const stall = obj(root['stall_categories'], source, 'stall_categories');
  const imports = arr(stall['imports'], source, 'stall_categories.imports').map((v, i) =>
    stallCategory(v, source, `stall_categories.imports[${i}]`),
  );
  const exports_ = arr(stall['exports'], source, 'stall_categories.exports').map((v, i) =>
    stallCategory(v, source, `stall_categories.exports[${i}]`),
  );
  if (imports.length === 0 && exports_.length === 0) {
    fail('stall_categories が空。stall を並べられない', source, 'stall_categories');
  }
  const seen = new Set<string>();
  for (const c of [...imports, ...exports_]) {
    if (seen.has(c.id)) fail(`stall_categories の id が重複している: ${c.id}`, source, 'stall_categories');
    seen.add(c.id);
  }

  const economy = obj(root['economy'], source, 'economy');
  const modules = obj(economy['modules'], source, 'economy.modules');
  const commissionFlow = obj(economy['commission_flow'], source, 'economy.commission_flow');

  // 検証済みの形だけを組み直す。未使用ブロック（presentation 等）はそのまま通す。
  const config: WorldConfig = {
    version: str(root['version'], source, 'version'),
    status: str(root['status'], source, 'status'),
    setting: root['setting'] as WorldConfig['setting'],
    constraints: obj(root['constraints'], source, 'constraints'),
    naming: resolvedNaming,
    core_mapping: arr(root['core_mapping'], source, 'core_mapping') as WorldConfig['core_mapping'],
    stall_categories: { imports, exports: exports_ },
    trade_partners: arr(root['trade_partners'], source, 'trade_partners') as WorldConfig['trade_partners'],
    market_logic_ja: str(root['market_logic_ja'], source, 'market_logic_ja'),
    participants: arr(root['participants'], source, 'participants') as WorldConfig['participants'],
    economy: {
      center: str(economy['center'], source, 'economy.center'),
      center_label_ja: str(economy['center_label_ja'], source, 'economy.center_label_ja'),
      confirmed: bool(economy['confirmed'], source, 'economy.confirmed'),
      modules: {
        primary: str(modules['primary'], source, 'economy.modules.primary'),
        secondary: str(modules['secondary'], source, 'economy.modules.secondary'),
      },
      module_detail: arr(economy['module_detail'], source, 'economy.module_detail') as never,
      core_binding: arr(economy['core_binding'], source, 'economy.core_binding') as never,
      commission_flow: {
        confirmed: bool(commissionFlow['confirmed'], source, 'economy.commission_flow.confirmed'),
        legs: str(commissionFlow['legs'], source, 'economy.commission_flow.legs'),
        remote_handling: str(commissionFlow['remote_handling'], source, 'economy.commission_flow.remote_handling'),
        settlement_unit: str(commissionFlow['settlement_unit'], source, 'economy.commission_flow.settlement_unit'),
      },
    },
    writing_premise_ja: str(root['writing_premise_ja'], source, 'writing_premise_ja'),
    presentation: obj(root['presentation'], source, 'presentation') as WorldConfig['presentation'],
  };
  return config;
}
