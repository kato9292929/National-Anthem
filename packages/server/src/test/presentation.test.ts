import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assignedMeshSlots,
  isFirstPass,
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

test('見た目は一次案のまま（方向は確定・値は要調整）', () => {
  assert.equal(config.confirmed, false);
  assert.equal(isFirstPass(config), true, '一次値であることを示していない');
  assert.equal(config.tuning.owner, 'kato');
  assert.deepEqual(unconfirmedPresentation(config).sort(), [
    'assets',
    'lighting',
    'materials',
    'palette',
    'performance',
    'postprocess',
  ]);
  assert.deepEqual(config.assets.textures, {}, 'テクスチャの受け口は空のまま');
  // メッシュはスロットごとに埋まるが、既定はすべて未割り当て（url 空）。
  for (const slot of MATERIAL_SLOT_IDS) {
    assert.equal(config.assets.meshes[slot].url, '', `${slot} に既定でメッシュが入っている`);
    assert.equal(config.assets.meshes[slot].placeholder, false);
  }
  assert.equal(assignedMeshSlots(config).length, 0, '既定で割り当てられたメッシュがある');
});

test('一次案の芯: posterize → outline → colorGrade → grain の順で積む', () => {
  const colorGrade = config.postprocess.passes.find((p) => p.id === 'colorGrade')!;
  assert.equal(colorGrade.params['saturation'], 0.7, '彩度を落としていない');
  assert.equal(colorGrade.colorParams?.['shadowColor'], '#0E0B08', '暗部の寄せ先が指定と違う');
  assert.ok(colorGrade.params['gamma']! < 1, 'ガンマを下げていない');
  assert.equal(config.postprocess.passes.find((p) => p.id === 'posterize')!.params['levels'], 5);
  const active = config.postprocess.passes.filter((p) => p.enabled && p.strength > 0).map((p) => p.id);
  assert.deepEqual(active, ['posterize', 'outline', 'colorGrade', 'grain']);
  for (const pass of config.postprocess.passes) {
    assert.ok(pass.strength >= 0 && pass.strength <= 1, `${pass.id} の強度が範囲外`);
    if (!pass.enabled) assert.equal(pass.strength, 0, `${pass.id} は無効なのに強度が残っている`);
  }
  // dither は任意なので既定は無効、tonemap は既存のまま。
  assert.equal(config.postprocess.passes.find((p) => p.id === 'dither')!.enabled, false);
  assert.equal(config.postprocess.passes.find((p) => p.id === 'tonemap')!.enabled, false);
});

test('一次案の質感: すべてのスロットに値が入り、暗く低彩度に寄っている', () => {
  for (const slot of MATERIAL_SLOT_IDS) {
    const params = config.materials.slots[slot].params;
    for (const key of ['bands', 'rim', 'warp', 'tint']) {
      assert.equal(typeof params[key], 'number', `materials.slots.${slot}.params.${key} が無い`);
    }
    assert.ok(params['bands']! >= 2, `${slot} の階調が量子化されていない`);
  }

  // 空と霧は黒寄り（暗部の底）。
  for (const key of ['sky', 'fog']) {
    assert.ok(hslOf(requireColor(config, key)).luminance < 0.15, `${key} が明るすぎる`);
  }
  // 低彩度。
  for (const key of ['wallBase', 'floorBase', 'stallWood', 'counterWood', 'gateStone']) {
    const { saturation } = hslOf(requireColor(config, key));
    assert.ok(saturation < 0.5, `${key} の彩度が高すぎる: ${saturation.toFixed(2)}`);
  }
  // base / shadow の対: shadow は必ず base より暗い。
  const pairs: [string, string][] = [
    ['wallBase', 'wallShadow'],
    ['floorBase', 'floorShadow'],
    ['stallWood', 'stallWoodShadow'],
    ['counterWood', 'counterWoodShadow'],
    ['gateStone', 'gateStoneShadow'],
    ['stallClothWarm', 'stallClothWarmShadow'],
    ['stallClothCool', 'stallClothCoolShadow'],
  ];
  for (const [base, shadow] of pairs) {
    const b = hslOf(requireColor(config, base)).luminance;
    const sh = hslOf(requireColor(config, shadow)).luminance;
    assert.ok(sh < b, `${shadow} が ${base} より暗くない`);
  }
  // 土・木・石は暖色寄り（布の寒色は除く）。
  for (const key of ['wallBase', 'floorBase', 'stallWood', 'counterWood', 'gateStone']) {
    const { r, b } = rgbOf(requireColor(config, key));
    assert.ok(r > b, `${key} が暖色に寄っていない`);
  }
  // キーライトは夕方寄りアンバー（r > g > b）。
  const key = rgbOf(requireColor(config, config.lighting.keyColorKey));
  assert.ok(key.r > key.g && key.g > key.b, 'キーライトがアンバーに寄っていない');
  assert.ok(config.lighting.ambientIntensity < config.lighting.keyIntensity, '低キーになっていない');
  // 低い斜光。
  assert.ok(config.lighting.keyElevationDeg > 0 && config.lighting.keyElevationDeg <= 30, '斜光が低くない');
});

test('ニュートラル構成（すべて無効・0）も引き続き通る', () => {
  const neutral = structuredClone(raw) as {
    mode: string;
    postprocess: { passes: { enabled: boolean; strength: number }[] };
    materials: { slots: Record<string, { params: Record<string, number> }> };
  };
  neutral.mode = 'greybox';
  for (const pass of neutral.postprocess.passes) {
    pass.enabled = false;
    pass.strength = 0;
  }
  for (const slot of Object.values(neutral.materials.slots)) {
    for (const key of Object.keys(slot.params)) slot.params[key] = 0;
  }
  const parsed = validatePresentationConfig(neutral, 'neutral');
  assert.equal(parsed.mode, 'greybox');
  assert.equal(parsed.postprocess.passes.every((p) => !p.enabled), true);
});

test('greybox 経路は残す。ポスプロは stylized にだけ掛ける', () => {
  assert.equal(config.mode, 'stylized', '方向が確定したので既定は stylized');
  assert.deepEqual(config.postprocess.appliesTo, ['stylized'], 'greybox は素のまま残す');
  assert.equal(config.declared_in, 'world/world.config.json#presentation');
});

test('確定していないのに confirmed 扱いにできない', () => {
  const lying = structuredClone(raw) as { tuning: { status: string } };
  lying.tuning.status = 'confirmed';
  assert.throws(() => validatePresentationConfig(lying, 'test'), /confirmed:false のまま/);
});

function rgbOf(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  };
}

function hslOf(hex: string): { luminance: number; saturation: number } {
  const { r, g, b } = rgbOf(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const luminance = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * luminance - 1));
  return { luminance, saturation };
}

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
  assert.equal(typeof requireColor(config, 'floorBase'), 'string');
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

test('パスに要るパラメータが欠けていたら読み込み時に落ちる（ブラウザまで持ち越さない）', () => {
  const missingLevels = structuredClone(raw) as { postprocess: { passes: Record<string, unknown>[] } };
  const posterize = missingLevels.postprocess.passes.find((p) => p['id'] === 'posterize')!;
  posterize['params'] = { steps: 5 };
  assert.throws(() => validatePresentationConfig(missingLevels, 'test'), /posterize\).params に levels が無い/);

  const missingColor = structuredClone(raw) as { postprocess: { passes: Record<string, unknown>[] } };
  const grade = missingColor.postprocess.passes.find((p) => p['id'] === 'colorGrade')!;
  delete grade['colorParams'];
  assert.throws(() => validatePresentationConfig(missingColor, 'test'), /colorGrade\).colorParams に shadowColor が無い/);
});

test('マテリアルは base / shadow の対で色を引く（stall は木枠と布で別）', () => {
  for (const key of [
    'wallBase',
    'wallShadow',
    'floorBase',
    'floorShadow',
    'stallWood',
    'stallClothWarm',
    'stallClothCool',
    'counterWood',
    'gateStone',
  ]) {
    assert.equal(typeof requireColor(config, key), 'string', `${key} が無い`);
  }
});
