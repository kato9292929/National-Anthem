import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MATERIAL_SLOT_IDS,
  POST_PASS_IDS,
  requireColor,
  unconfirmedPresentation,
  validatePresentationConfig,
} from '@na/shared';
import { loadPresentationConfig } from '@na/shared/node';

const loaded = loadPresentationConfig({});
const config = loaded.value;
const raw = JSON.parse(readFileSync(loaded.path, 'utf8')) as Record<string, unknown>;

test('見た目はすべて未確定で、ニュートラル既定（＝効果なし）で動く', () => {
  assert.equal(config.confirmed, false);
  assert.deepEqual(unconfirmedPresentation(config).sort(), [
    'assets',
    'lighting',
    'materials',
    'palette',
    'performance',
    'postprocess',
  ]);
  for (const pass of config.postprocess.passes) {
    assert.ok(!pass.enabled || pass.strength === 0, `${pass.id} が既定で効いている`);
  }
  for (const slot of MATERIAL_SLOT_IDS) {
    for (const [key, value] of Object.entries(config.materials.slots[slot].params)) {
      assert.equal(value, 0, `materials.slots.${slot}.params.${key} が既定で効いている`);
    }
  }
  assert.deepEqual(config.assets.textures, {}, 'アセットの受け口は空');
  assert.deepEqual(config.assets.meshes, {});
});

test('greybox が既定で、stylized はトグルで入る', () => {
  assert.equal(config.mode, 'greybox');
  assert.equal(config.declared_in, 'world/world.config.json#presentation');
});

test('未知のパス種別・スロットは受け付けない（推測で通さない）', () => {
  const withUnknownPass = structuredClone(raw) as { postprocess: { passes: { id: string }[] } };
  withUnknownPass.postprocess.passes.push({ id: 'bloom', enabled: false, strength: 0, params: {} } as never);
  assert.throws(() => validatePresentationConfig(withUnknownPass, 'test'), /postprocess\.passes\[\d+\]\.id/);

  const withUnknownSlot = structuredClone(raw) as { materials: { slots: Record<string, unknown> } };
  withUnknownSlot.materials.slots['ceiling'] = { shader: 'stylized-surface', params: {} };
  assert.throws(() => validatePresentationConfig(withUnknownSlot, 'test'), /未知のマテリアルスロット: ceiling/);
});

test('パスの重複と範囲外の強度を弾く', () => {
  const duplicated = structuredClone(raw) as { postprocess: { passes: { id: string }[] } };
  duplicated.postprocess.passes.push({ ...duplicated.postprocess.passes[0]! });
  assert.throws(() => validatePresentationConfig(duplicated, 'test'), /重複している/);

  const tooStrong = structuredClone(raw) as { postprocess: { passes: { strength: number }[] } };
  tooStrong.postprocess.passes[0]!.strength = 1.5;
  assert.throws(() => validatePresentationConfig(tooStrong, 'test'), /strength は 0\.\.1/);
});

test('パラメータが欠けていたら既定で補わずに落ちる', () => {
  const missing = structuredClone(raw) as { materials: { slots: Record<string, unknown> } };
  missing.materials.slots['floor'] = { shader: 'stylized-surface', params: { bands: 'many' } };
  assert.throws(() => validatePresentationConfig(missing, 'test'), /materials\.slots\.floor\.params\.bands/);
});

test('必要な色が無ければ落ちる（既定色を作らない）', () => {
  assert.equal(typeof requireColor(config, 'floor'), 'string');
  assert.throws(() => requireColor(config, 'no-such-color'), /palette\.colors/);
});

test('パス種別の一覧はスキーマ側に固定されている', () => {
  assert.deepEqual([...POST_PASS_IDS], ['tonemap', 'posterize', 'dither', 'outline', 'grain', 'colorGrade']);
  const configured = config.postprocess.passes.map((p) => p.id);
  for (const id of configured) assert.ok(POST_PASS_IDS.includes(id));
});

test('パス種別ごとの実装が client 側に揃っている', () => {
  const source = readFileSync(new URL('../../../client/src/presentation/passes.ts', import.meta.url), 'utf8');
  for (const id of POST_PASS_IDS) {
    assert.ok(new RegExp(`${id}: \\{`).test(source), `${id} のパス実装が無い`);
  }
});
