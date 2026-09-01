import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadWorldConfig } from '@na/shared/node';

/**
 * ビジュアル確定後に presentation 層を重ねるだけで入る状態を、構造として固定する。
 * - presentation.* はロジックから読まない
 * - グレイボックスの見た目の値は greybox.ts の 1 ファイルに閉じる
 * - 固有名はソースにリテラルで書かない
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function sourceFiles(dir: string, extension = '.ts'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path, extension));
    else if (path.endsWith(extension)) out.push(path);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('presentation.* をロジックから読んでいない', () => {
  const files = [
    ...sourceFiles(join(repoRoot, 'packages/server/src')),
    ...sourceFiles(join(repoRoot, 'packages/client/src')),
  ].filter((f) => !f.includes('/test/'));
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    assert.ok(
      !/\.presentation\b/.test(text) && !/\bpresentation\[/.test(text),
      `${file} が presentation を参照している`,
    );
  }
  // 型と検証だけは presentation を知っていてよい（値は読まない）。
  const shared = stripComments(readFileSync(join(repoRoot, 'packages/shared/src/validate.ts'), 'utf8'));
  assert.ok(shared.includes('presentation'), '検証は presentation ブロックの存在を見る');
});

test('色の値はソースに 1 つも無い（presentation config から差す）', () => {
  const files = sourceFiles(join(repoRoot, 'packages/client/src'));
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const colors = text.match(/#[0-9a-fA-F]{6}\b|rgba?\(|0x[0-9a-fA-F]{6}\b/g) ?? [];
    assert.deepEqual(colors, [], `${file} に色の値が散っている: ${colors.join(', ')}`);
  }
  // greybox.ts に残るのは寸法だけ。
  const greybox = readFileSync(join(repoRoot, 'packages/client/src/greybox.ts'), 'utf8');
  assert.ok(!/color|Color/.test(stripComments(greybox)), 'greybox.ts に色が残っている');
});

test('見た目の値をサーバ側のロジックに漏らしていない', () => {
  const files = sourceFiles(join(repoRoot, 'packages/server/src')).filter((f) => !f.includes('/test/'));
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const colors = text.match(/#[0-9a-fA-F]{6}\b|rgba?\(/g) ?? [];
    assert.deepEqual(colors, [], `${file} に色の値がある: ${colors.join(', ')}`);
  }
  // サーバは presentation config を配るだけで、中身を解釈しない。
  const logicDirs = ['market', 'identity', 'commission', 'x402', 'privacy', 'agent', 'adapters', 'store'];
  for (const dir of logicDirs) {
    for (const file of sourceFiles(join(repoRoot, 'packages/server/src', dir))) {
      const text = stripComments(readFileSync(file, 'utf8'));
      assert.ok(!/presentation|palette|postprocess|shader/i.test(text), `${file} が見た目を参照している`);
    }
  }
});

test('シェーダとパスにマジックナンバーの色を置いていない', () => {
  const files = sourceFiles(join(repoRoot, 'packages/client/src/presentation'));
  assert.ok(files.length >= 5, 'presentation 層のファイルが見つからない');
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const colors = text.match(/#[0-9a-fA-F]{6}\b|0x[0-9a-fA-F]{6}\b/g) ?? [];
    assert.deepEqual(colors, [], `${file} に色の値がある: ${colors.join(', ')}`);
  }
});

test('固有名の仮値をソースに書いていない（config から引く）', () => {
  const { config } = loadWorldConfig({});
  const placeholders = Object.values(config.naming).map((n) => n.value);
  const files = [
    ...sourceFiles(join(repoRoot, 'packages/server/src')),
    ...sourceFiles(join(repoRoot, 'packages/client/src')),
  ].filter((f) => !f.includes('/test/'));

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const placeholder of placeholders) {
      assert.ok(!text.includes(placeholder), `${file} に固有名の仮値 ${placeholder} が書かれている`);
    }
  }
});

test('市場・品目のリテラルをクライアントに書いていない（config 由来のまま）', () => {
  const ids = [
    ...loadWorldConfig({}).config.stall_categories.imports,
    ...loadWorldConfig({}).config.stall_categories.exports,
  ].map((c) => c.id);
  const files = sourceFiles(join(repoRoot, 'packages/client/src'));
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const id of ids) {
      assert.ok(
        !new RegExp(`['"\`]${id}['"\`]`).test(text),
        `${file} に品目 ${id} がリテラルで書かれている`,
      );
    }
  }
});
