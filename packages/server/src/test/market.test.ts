import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { seedFrom } from '@na/shared';
import { loadWorldConfig } from '@na/shared/node';
import { MarketSimulation } from '../market/simulation.js';

const { config } = loadWorldConfig({});
const SEED = seedFrom('na-v0-test');

function sim(seed = SEED): MarketSimulation {
  return new MarketSimulation({ config, seed });
}

test('品目は config の stall_categories から生成される（ハードコードしない）', () => {
  const expected = [
    ...config.stall_categories.imports.map((c) => c.id),
    ...config.stall_categories.exports.map((c) => c.id),
  ];
  assert.deepEqual(sim().items.map((i) => i.id), expected);
  assert.deepEqual(
    sim().items.map((i) => i.direction),
    [
      ...config.stall_categories.imports.map(() => 'import'),
      ...config.stall_categories.exports.map(() => 'export'),
    ],
  );
});

test('時間経過で価格と在庫が動く', () => {
  const s = sim();
  const before = s.state(0);
  s.stepMany(200);
  const after = s.state(0);
  assert.equal(after.tick, 200);
  for (const item of s.items) {
    const a = before.states.find((x) => x.itemId === item.id)!;
    const b = after.states.find((x) => x.itemId === item.id)!;
    assert.notEqual(a.price, b.price, `${item.id} の価格が動いていない`);
    assert.notEqual(a.stock, b.stock, `${item.id} の在庫が動いていない`);
    assert.ok(b.price > 0, `${item.id} の価格が正でない`);
    assert.ok(b.stock >= 0, `${item.id} の在庫が負`);
  }
});

test('長時間回しても枯渇も暴騰もしない（平均回帰する）', () => {
  const s = sim();
  const observed = new Map<string, number[]>(s.items.map((i) => [i.id, []]));
  for (let t = 0; t < 1000; t++) {
    s.step();
    for (const state of s.state(0).states) observed.get(state.itemId)!.push(state.price);
  }
  const final = s.state(0);
  for (const item of s.items) {
    const prices = observed.get(item.id)!;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const stock = final.states.find((x) => x.itemId === item.id)!.stock;
    assert.ok(stock > 0, `${item.id} の在庫が枯渇した`);
    assert.ok(max > min, `${item.id} の価格が動いていない`);
    // 基準価格の周りに留まる。天井・床への張り付きを許さない。
    assert.ok(max < item.basePrice * 3.5, `${item.id} の価格が上限に張り付いた: ${max}`);
    assert.ok(min > item.basePrice * 0.35, `${item.id} の価格が下限に張り付いた: ${min}`);
  }
});

test('同一シードなら再現する', () => {
  const a = sim().trace(150);
  const b = sim().trace(150);
  assert.deepEqual(a, b);
});

test('シードが違えば系列も違う', () => {
  const a = sim(seedFrom('seed-a')).trace(150);
  const b = sim(seedFrom('seed-b')).trace(150);
  assert.notDeepEqual(a.ticks, b.ticks);
});

test('手動入力を含めても、同じ入力列なら再現する', () => {
  const run = (): unknown => {
    const s = sim();
    s.stepMany(20);
    s.applyShock({ itemId: s.items[0]!.id, supplyMultiplier: 0.2, durationTicks: 30, note: 'test' });
    s.stepMany(60);
    return s.state(0).states;
  };
  assert.deepEqual(run(), run());
});

test('供給ショックは在庫を押し下げ、価格を押し上げる', () => {
  const target = sim().items[0]!.id;
  const withShock = sim();
  const without = sim();
  withShock.stepMany(20);
  without.stepMany(20);
  withShock.applyShock({ itemId: target, supplyMultiplier: 0.1, durationTicks: 40, note: 'test' });
  withShock.stepMany(40);
  without.stepMany(40);
  const a = withShock.state(0).states.find((s) => s.itemId === target)!;
  const b = without.state(0).states.find((s) => s.itemId === target)!;
  assert.ok(a.stock < b.stock, '在庫が下がっていない');
  assert.ok(a.price > b.price, '価格が上がっていない');
});

test('未知の品目・不正な値のショックは黙って無視せず落ちる', () => {
  assert.throws(() => sim().applyShock({ itemId: 'no-such-item', supplyMultiplier: 0.5, durationTicks: 5, note: '' }), /no-such-item/);
  assert.throws(() => sim().applyShock({ itemId: sim().items[0]!.id, supplyMultiplier: 0, durationTicks: 5, note: '' }), /supplyMultiplier/);
});

test('市場シムに Math.random / LLM / 決済の呼び出しが無い', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../src/market');
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(sources.length >= 3);
  for (const file of sources) {
    // コメントは落としてから見る（「Math.random は使わない」という記述自体に反応させない）。
    const text = readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(!text.includes('Math.random'), `${file} が Math.random を使っている`);
    assert.ok(!/\bfetch\s*\(/.test(text), `${file} が外部呼び出しをしている`);
  }
});
