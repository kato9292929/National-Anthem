import { bool, num, obj, str } from './guards.js';

/** M6 エージェント自律の config。稼働前ゲートの判定材料になる。 */

export interface ModelPricing {
  input: number;
  output: number;
  cacheReadMultiplier: number;
  cacheWriteMultiplier: number;
}

export interface AgentConfig {
  version: string;
  models: {
    quoting: string;
    judgement: string;
    escalation: string;
    opusAllowed: boolean;
    confirmed: boolean;
  };
  pricing: { as_of: string; verified: boolean; perModel: Record<string, ModelPricing> };
  caching: {
    enabled: boolean;
    breakpoint: string;
    ttl: string;
    requireCacheHit: boolean;
    confirmed: boolean;
  };
  cadence: {
    /** null は未確定。埋まるまで schedule で回さない。 */
    tickIntervalSeconds: number | null;
    maxInputTokensPerCall: number | null;
    maxCallsPerTick: number | null;
    confirmed: boolean;
  };
  budget: {
    hardCapUsd: number;
    warnAtUsd: number;
    notify: boolean;
    autoReload: boolean;
    confirmed: boolean;
  };
  run: { dryRunRequired: boolean; measurementPath: string };
}

function numOrNull(value: unknown, source: string, key: string): number | null {
  if (value === null) return null;
  return num(value, source, key);
}

export function validateAgentConfig(input: unknown, source: string): AgentConfig {
  const root = obj(input, source, '(root)');
  const models = obj(root['models'], source, 'models');
  const pricing = obj(root['pricing'], source, 'pricing');
  const perModel = obj(pricing['perModel'], source, 'pricing.perModel');
  const caching = obj(root['caching'], source, 'caching');
  const cadence = obj(root['cadence'], source, 'cadence');
  const budget = obj(root['budget'], source, 'budget');
  const run = obj(root['run'], source, 'run');

  if (bool(models['opusAllowed'], source, 'models.opusAllowed')) {
    throw new Error(`${source}: opus 全採用にしない。判定・quoting は Haiku / Sonnet から`);
  }
  if (bool(budget['autoReload'], source, 'budget.autoReload')) {
    throw new Error(`${source}: auto-reload は垂れ流しになるので許可しない`);
  }

  const pricingMap: Record<string, ModelPricing> = {};
  for (const [model, value] of Object.entries(perModel)) {
    if (model.startsWith('$')) continue;
    const o = obj(value, source, `pricing.perModel.${model}`);
    pricingMap[model] = {
      input: num(o['input'], source, `pricing.perModel.${model}.input`),
      output: num(o['output'], source, `pricing.perModel.${model}.output`),
      cacheReadMultiplier: num(o['cacheReadMultiplier'], source, `pricing.perModel.${model}.cacheReadMultiplier`),
      cacheWriteMultiplier: num(o['cacheWriteMultiplier'], source, `pricing.perModel.${model}.cacheWriteMultiplier`),
    };
  }

  const config: AgentConfig = {
    version: str(root['version'], source, 'version'),
    models: {
      quoting: str(models['quoting'], source, 'models.quoting'),
      judgement: str(models['judgement'], source, 'models.judgement'),
      escalation: str(models['escalation'], source, 'models.escalation'),
      opusAllowed: false,
      confirmed: bool(models['confirmed'], source, 'models.confirmed'),
    },
    pricing: {
      as_of: str(pricing['as_of'], source, 'pricing.as_of'),
      verified: bool(pricing['verified'], source, 'pricing.verified'),
      perModel: pricingMap,
    },
    caching: {
      enabled: bool(caching['enabled'], source, 'caching.enabled'),
      breakpoint: str(caching['breakpoint'], source, 'caching.breakpoint'),
      ttl: str(caching['ttl'], source, 'caching.ttl'),
      requireCacheHit: bool(caching['requireCacheHit'], source, 'caching.requireCacheHit'),
      confirmed: bool(caching['confirmed'], source, 'caching.confirmed'),
    },
    cadence: {
      tickIntervalSeconds: numOrNull(cadence['tickIntervalSeconds'], source, 'cadence.tickIntervalSeconds'),
      maxInputTokensPerCall: numOrNull(cadence['maxInputTokensPerCall'], source, 'cadence.maxInputTokensPerCall'),
      maxCallsPerTick: numOrNull(cadence['maxCallsPerTick'], source, 'cadence.maxCallsPerTick'),
      confirmed: bool(cadence['confirmed'], source, 'cadence.confirmed'),
    },
    budget: {
      hardCapUsd: num(budget['hardCapUsd'], source, 'budget.hardCapUsd'),
      warnAtUsd: num(budget['warnAtUsd'], source, 'budget.warnAtUsd'),
      notify: bool(budget['notify'], source, 'budget.notify'),
      autoReload: false,
      confirmed: bool(budget['confirmed'], source, 'budget.confirmed'),
    },
    run: {
      dryRunRequired: bool(run['dryRunRequired'], source, 'run.dryRunRequired'),
      measurementPath: str(run['measurementPath'], source, 'run.measurementPath'),
    },
  };

  for (const key of ['quoting', 'judgement', 'escalation'] as const) {
    const model = config.models[key];
    if (!pricingMap[model]) {
      throw new Error(`${source}: models.${key} (${model}) の料金が pricing.perModel に無い`);
    }
  }
  return config;
}
