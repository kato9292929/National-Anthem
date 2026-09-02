import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlaceholderMeshGenerator } from '../placeholder-generator.js';
import { triangleCount, writeGlb } from '../glb-writer.js';
import { MESH_TARGETS } from '../targets.js';

test('writeGlb が正しい GLB ヘッダを出す', () => {
  const glb = writeGlb([{ cx: 0, cy: 0.5, cz: 0, sx: 1, sy: 1, sz: 1 }]);
  assert.equal(glb.readUInt32LE(0), 0x46546c67, 'magic が glTF でない');
  assert.equal(glb.readUInt32LE(4), 2, 'version が 2 でない');
  assert.equal(glb.readUInt32LE(8), glb.length, '宣言長とファイル長が食い違う');
  // JSON チャンクが先。
  assert.equal(glb.readUInt32LE(16), 0x4e4f534a, '最初のチャンクが JSON でない');
  assert.equal(triangleCount([{ cx: 0, cy: 0, cz: 0, sx: 1, sy: 1, sz: 1 }]), 12);
});

test('placeholder ジェネレータは各種別の .glb を出し、placeholder を残す', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'na-glb-'));
  try {
    const generator = new PlaceholderMeshGenerator({ outputDir: dir });
    assert.equal(generator.status().mode, 'placeholder');
    assert.equal(generator.status().verified, false);

    for (const target of MESH_TARGETS) {
      const result = await generator.generate(target);
      assert.equal(result.placeholder, true, `${target.slot} が placeholder でない`);
      assert.equal(result.costUsd, 0);
      assert.ok(result.triangles > 0);
      const glb = readFileSync(result.glbPath);
      assert.equal(glb.readUInt32LE(0), 0x46546c67, `${target.slot} の .glb が壊れている`);
      // 生成物は低ポリ（配管確認用）。
      assert.ok(result.triangles < 1000, `${target.slot} が想定外に高ポリ`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
