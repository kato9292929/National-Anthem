import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AssetBatchBlockedError, assertBatchAllowed, validateAssetsConfig } from '@na/shared';
import { loadAssetsConfig } from '@na/shared/node';

const loaded = loadAssetsConfig({});
const config = loaded.value;
const raw = JSON.parse(readFileSync(loaded.path, 'utf8')) as Record<string, unknown>;

test('生成は未確認で、既定は placeholder', () => {
  assert.equal(config.generator.tool, 'placeholder');
  assert.equal(config.generator.confirmed, false);
  assert.equal(config.generator.verified, false);
  assert.equal(config.budget.measuredCostPerMeshUsd, null, '1 回あたりのコストは未実測');
});

test('実測前はバッチできない（osd の再発防止）', () => {
  assert.throws(() => assertBatchAllowed(config, 20), (error: unknown) => {
    assert.ok(error instanceof AssetBatchBlockedError);
    assert.match(error.message, /未実測/);
    return true;
  });
});

test('実測が入ってもキャップを超えるバッチは止まる', () => {
  const measured = { ...config, budget: { ...config.budget, measuredCostPerMeshUsd: 0.5 } };
  assert.doesNotThrow(() => assertBatchAllowed(measured, 8)); // 4.0 < 5.0
  assert.throws(() => assertBatchAllowed(measured, 20), /ハードキャップ/); // 10.0 > 5.0
});

test('ライセンス状態を config に記録している', () => {
  assert.match(config.license.tripoFree, /non-commercial|非商用/);
  assert.equal(config.license.meshyFree, 'CC BY');
  assert.match(config.license.currentAssets, /placeholder/);
  assert.match(config.license.shipping, /有料プラン/);
});

test('ポリゴン予算がクライアントの予算と一致する', () => {
  assert.equal(config.polyBudget.maxTriangles, 40000);
});

test('measuredCostPerMeshUsd が数値でも null でも読める', () => {
  const withNumber = validateAssetsConfig(
    { ...raw, budget: { ...(raw['budget'] as object), measuredCostPerMeshUsd: 0.3 } },
    'test',
  );
  assert.equal(withNumber.budget.measuredCostPerMeshUsd, 0.3);
});

test('Tripo の設定: 参照画像とコストは未実測（バッチ前提を保つ）', () => {
  assert.equal(config.generator.tool, 'placeholder', '既定は placeholder（実生成は明示的に切り替え）');
  assert.equal(config.tripo.pythonBin, 'python3');
  assert.equal(config.tripo.estimatedCostUsd, null, '1 回あたりのコストは実測前');
  for (const slot of ['wall', 'stall', 'gate', 'counter', 'floor']) {
    assert.ok(config.tripo.references[slot], `${slot} の参照画像パスが無い`);
  }
});
