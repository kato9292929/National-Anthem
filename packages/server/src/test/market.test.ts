import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { seedFrom } from '@na/shared';
import { loadMarketStructureConfig, loadWorldConfig } from '@na/shared/node';
import { MarketSimulation } from '../market/simulation.js';

const { config } = loadWorldConfig({});
const SEED = seedFrom('na-v0-test');

const structure = loadMarketStructureConfig({}).value;

function sim(seed = SEED): MarketSimulation {
  return new MarketSimulation({ config, seed });
}

function linkedSim(seed = SEED): MarketSimulation {
  return new MarketSimulation({ config, seed, structure });
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

test('連関と分布の設定はすべて仮値（confirmed: false）', () => {
  assert.equal(structure.links.confirmed, false);
  assert.equal(structure.shockPropagation.confirmed, false);
  assert.equal(structure.stalls.confirmed, false);
  for (const edge of structure.links.edges) {
    const ids = [
      ...config.stall_categories.imports.map((c) => c.id),
      ...config.stall_categories.exports.map((c) => c.id),
    ];
    assert.ok(ids.includes(edge.from), `連関の from が config に無い: ${edge.from}`);
    assert.ok(ids.includes(edge.to), `連関の to が config に無い: ${edge.to}`);
  }
});

test('ショックが連関をたどって伝わり、出所が残る', () => {
  const s = linkedSim();
  s.stepMany(20);
  const edge = structure.links.edges.find((e) => e.kind === 'input')!;
  s.applyShock({ itemId: edge.from, supplyMultiplier: 0.1, durationTicks: 40, note: 'propagation-test' });
  s.step();

  const state = s.state(0);
  const source = state.states.find((x) => x.itemId === edge.from)!;
  const target = state.states.find((x) => x.itemId === edge.to)!;
  assert.equal(source.shock?.origin, 'manual');
  assert.equal(target.shock, null, '伝播先には直撃のショックは無い');
  const fromShock = target.propagation.find((p) => p.fromItemId === edge.from);
  assert.ok(fromShock, `${edge.from} からの伝播が記録されていない`);
  assert.equal(fromShock.hops, 1);
  assert.ok(target.supplyMultiplier < 1, '伝播先の実効供給が下がっていない');
});

test('伝播は最大ホップ数で止まり、閾値未満は伝えない', () => {
  const s = linkedSim();
  s.stepMany(10);
  s.applyShock({ itemId: 'metal', supplyMultiplier: 0.1, durationTicks: 30, note: 'hops' });
  s.step();
  for (const line of s.state(0).states) {
    for (const effect of line.propagation) {
      assert.ok(effect.hops <= structure.shockPropagation.maxHops, `ホップ数超過: ${effect.hops}`);
      assert.ok(effect.effect >= structure.shockPropagation.minEffect, `閾値未満を伝えている: ${effect.effect}`);
    }
  }
});

test('伝播先は伝播が無い場合より在庫が減り、価格が上がる', () => {
  const withLinks = linkedSim();
  const withoutLinks = new MarketSimulation({
    config,
    seed: SEED,
    structure: { ...structure, shockPropagation: { ...structure.shockPropagation, enabled: false } },
  });
  const edge = structure.links.edges.find((e) => e.to === 'craft')!;
  for (const s of [withLinks, withoutLinks]) {
    s.stepMany(20);
    s.applyShock({ itemId: edge.from, supplyMultiplier: 0.05, durationTicks: 60, note: 'compare' });
    s.stepMany(60);
  }
  const a = withLinks.state(0).states.find((x) => x.itemId === edge.to)!;
  const b = withoutLinks.state(0).states.find((x) => x.itemId === edge.to)!;
  assert.ok(a.stock < b.stock, `伝播先の在庫が減っていない: ${a.stock} >= ${b.stock}`);
  assert.ok(a.price > b.price, `伝播先の価格が上がっていない: ${a.price} <= ${b.price}`);
});

test('連関を入れても決定論は保たれる', () => {
  assert.deepEqual(linkedSim().trace(150), linkedSim().trace(150));
  assert.notDeepEqual(linkedSim().trace(150).ticks, sim().trace(150).ticks);
});

test('stall の在庫分布はカテゴリの在庫に一致し、値付けだけばらつく', () => {
  const s = linkedSim();
  s.stepMany(40);
  const state = s.state(0);
  assert.equal(state.stalls.length, s.items.length * structure.stalls.perCategory);

  for (const item of s.items) {
    const line = state.states.find((x) => x.itemId === item.id)!;
    const stalls = state.stalls.filter((st) => st.itemId === item.id);
    assert.equal(stalls.length, structure.stalls.perCategory);
    const summed = stalls.reduce((sum, st) => sum + st.stock, 0);
    assert.ok(Math.abs(summed - line.stock) < 0.1, `${item.id} の在庫合計がずれている: ${summed} vs ${line.stock}`);
    for (const stall of stalls) {
      assert.equal(stall.provisional, true);
      const ratio = stall.price / line.price;
      assert.ok(
        Math.abs(ratio - 1) <= structure.stalls.priceSpread + 1e-9,
        `${stall.id} の値付けが設定のばらつきを超えている: ${ratio}`,
      );
    }
  }
});

test('stall の分布は同一シードで再現し、tick ごとに振り直さない', () => {
  const a = linkedSim();
  const b = linkedSim();
  a.stepMany(30);
  b.stepMany(30);
  assert.deepEqual(a.state(0).stalls, b.state(0).stalls);

  const first = a.state(0).stalls.map((s) => s.stock / Math.max(a.state(0).states.find((x) => x.itemId === s.itemId)!.stock, 1e-9));
  a.stepMany(10);
  const later = a.state(0).stalls.map((s) => s.stock / Math.max(a.state(0).states.find((x) => x.itemId === s.itemId)!.stock, 1e-9));
  for (const [index, share] of first.entries()) {
    // 値は round2 で丸めるので、比較は丸め幅を見込む。
    assert.ok(Math.abs(share - later[index]!) < 1e-2, '配分が tick ごとに動いている');
  }
});

test('連関を入れても長時間で枯渇しない', () => {
  const s = linkedSim();
  s.stepMany(1000);
  for (const line of s.state(0).states) {
    assert.ok(line.stock > 0, `${line.itemId} が枯渇した`);
    const item = s.items.find((i) => i.id === line.itemId)!;
    assert.ok(line.price < item.basePrice * 3.5, `${line.itemId} が上限に張り付いた`);
  }
});
