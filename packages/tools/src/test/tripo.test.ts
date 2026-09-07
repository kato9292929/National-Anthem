import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTripoMeshGenerator } from '../tripo-generator.js';
import { MeshGeneratorUnavailableError } from '../gen-types.js';
import { MESH_TARGETS } from '../targets.js';

const target = MESH_TARGETS[0]!;

test('鍵が無ければ MeshGeneratorUnavailableError で落ちる（偽 .glb を作らない）', async () => {
  const gen = createTripoMeshGenerator({ apiKey: undefined, outputDir: '/tmp', imageFor: () => '/tmp/x.jpg' });
  assert.equal(gen.status().verified, false);
  assert.deepEqual(gen.status().requires, ['TRIPO_API_KEY']);
  await assert.rejects(gen.generate(target), (e: unknown) => {
    assert.ok(e instanceof MeshGeneratorUnavailableError);
    return true;
  });
});

test('参照画像が無ければ落ちる', async () => {
  const gen = createTripoMeshGenerator({ apiKey: 'k', outputDir: '/tmp', imageFor: () => undefined });
  await assert.rejects(gen.generate(target), (e: unknown) => {
    assert.ok(e instanceof MeshGeneratorUnavailableError);
    return true;
  });
  const gen2 = createTripoMeshGenerator({ apiKey: 'k', outputDir: '/tmp', imageFor: () => '/no/such/ref.jpg' });
  await assert.rejects(gen2.generate(target), /参照画像が無い/);
});

test('SDK が無い / 生成が成功しなければ、成功に見せず落ちる', async () => {
  // python は本物、SDK は未インストール。ラッパが ok:false を返し、アダプタが throw する。
  const dir = mkdtempSync(join(tmpdir(), 'na-tripo-'));
  try {
    const ref = join(dir, 'ref.jpg');
    writeFileSync(ref, 'x');
    const gen = createTripoMeshGenerator({ apiKey: 'dummy', outputDir: dir, imageFor: () => ref });
    await assert.rejects(gen.generate(target), /Tripo 生成に失敗/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verified は実装完了では上がらない（実生成が通るまで false）', () => {
  const gen = createTripoMeshGenerator({ apiKey: 'k', outputDir: '/tmp', imageFor: () => '/tmp/x.jpg' });
  assert.equal(gen.status().verified, false);
  assert.match(gen.status().license, /非商用/);
});
