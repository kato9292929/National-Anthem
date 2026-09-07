import { bool, num, obj, str } from './guards.js';

/** config/assets.config.json。実生成は区分B。 */
export interface AssetsConfig {
  version: string;
  generator: { tool: string; confirmed: boolean; verified: boolean };
  tripo: {
    pythonBin: string;
    /** 1 回あたりのコスト（USD）。null の間はバッチできない（実測してから）。 */
    estimatedCostUsd: number | null;
    /** 要素種別 → 参照画像のパス。 */
    references: Record<string, string>;
  };
  budget: {
    hardCapUsd: number;
    warnAtUsd: number;
    /** 実測値。null の間はバッチできない。 */
    measuredCostPerMeshUsd: number | null;
    requireMeasurementBeforeBatch: boolean;
    confirmed: boolean;
  };
  license: {
    tripoFree: string;
    meshyFree: string;
    shipping: string;
    currentAssets: string;
  };
  polyBudget: { maxTriangles: number };
}

export function validateAssetsConfig(input: unknown, source: string): AssetsConfig {
  const root = obj(input, source, '(root)');
  const generator = obj(root['generator'], source, 'generator');
  const tripo = obj(root['tripo'], source, 'tripo');
  const references = obj(tripo['references'], source, 'tripo.references');
  const refMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(references)) {
    if (key.startsWith('$')) continue;
    refMap[key] = str(value, source, `tripo.references.${key}`);
  }
  const tripoCost = tripo['estimatedCostUsd'];
  const budget = obj(root['budget'], source, 'budget');
  const license = obj(root['license'], source, 'license');
  const poly = obj(root['polyBudget'], source, 'polyBudget');

  const measured = budget['measuredCostPerMeshUsd'];
  return {
    version: str(root['version'], source, 'version'),
    generator: {
      tool: str(generator['tool'], source, 'generator.tool'),
      confirmed: bool(generator['confirmed'], source, 'generator.confirmed'),
      verified: bool(generator['verified'], source, 'generator.verified'),
    },
    tripo: {
      pythonBin: str(tripo['pythonBin'], source, 'tripo.pythonBin'),
      estimatedCostUsd: tripoCost === null ? null : num(tripoCost, source, 'tripo.estimatedCostUsd'),
      references: refMap,
    },
    budget: {
      hardCapUsd: num(budget['hardCapUsd'], source, 'budget.hardCapUsd'),
      warnAtUsd: num(budget['warnAtUsd'], source, 'budget.warnAtUsd'),
      measuredCostPerMeshUsd: measured === null ? null : num(measured, source, 'budget.measuredCostPerMeshUsd'),
      requireMeasurementBeforeBatch: bool(
        budget['requireMeasurementBeforeBatch'],
        source,
        'budget.requireMeasurementBeforeBatch',
      ),
      confirmed: bool(budget['confirmed'], source, 'budget.confirmed'),
    },
    license: {
      tripoFree: str(license['tripoFree'], source, 'license.tripoFree'),
      meshyFree: str(license['meshyFree'], source, 'license.meshyFree'),
      shipping: str(license['shipping'], source, 'license.shipping'),
      currentAssets: str(license['currentAssets'], source, 'license.currentAssets'),
    },
    polyBudget: { maxTriangles: num(poly['maxTriangles'], source, 'polyBudget.maxTriangles') },
  };
}

export class AssetBatchBlockedError extends Error {
  override readonly name = 'AssetBatchBlockedError';
  constructor(readonly reason: string) {
    super(`生成バッチを止める: ${reason}`);
  }
}

/**
 * バッチ生成の前に通す関門。
 * 実測前のバッチ（osd の再発防止）と、キャップ超過を止める。
 */
export function assertBatchAllowed(config: AssetsConfig, meshCount: number): void {
  if (config.budget.requireMeasurementBeforeBatch && config.budget.measuredCostPerMeshUsd === null) {
    throw new AssetBatchBlockedError('1 回あたりのコストが未実測。実測してからバッチする');
  }
  const per = config.budget.measuredCostPerMeshUsd ?? 0;
  const total = per * meshCount;
  if (total > config.budget.hardCapUsd) {
    throw new AssetBatchBlockedError(
      `見積もり ${total.toFixed(2)} USD がハードキャップ ${config.budget.hardCapUsd} USD を超える`,
    );
  }
}
