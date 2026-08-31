import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ConfigError, resolveAllNames, resolveName, unconfirmedNames, validateWorldConfig } from '@na/shared';
import { loadWorldConfig, resolveWorldConfigPath } from '@na/shared/node';

test('リポジトリの world.config.json を型付きで読める', () => {
  const { config, path } = loadWorldConfig({});
  assert.match(path, /world\/world\.config\.json$/);
  assert.equal(config.version, '0');
  assert.ok(config.stall_categories.imports.length > 0);
  assert.ok(config.stall_categories.exports.length > 0);
  assert.equal(config.economy.modules.primary, 'commission-board');
});

test('naming は config から引く。未確定は仮値＋ラベルで表示する', () => {
  const { config } = loadWorldConfig({});
  const market = resolveName(config, 'market');
  assert.equal(market.confirmed, false);
  assert.match(market.display, /（未確定）$/);
  assert.ok(market.display.includes(market.value));
  assert.deepEqual(Object.keys(resolveAllNames(config)).sort(), ['district', 'market', 'npc', 'stall']);
  assert.deepEqual(unconfirmedNames(config).sort(), ['district', 'market', 'npc', 'stall']);
});

test('キーが欠けた config は既定値で埋めずに落ちる', () => {
  const raw = JSON.parse(readFileSync(resolveWorldConfigPath({}), 'utf8')) as Record<string, unknown>;
  delete raw['stall_categories'];
  assert.throws(() => validateWorldConfig(raw, 'test-fixture'), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /stall_categories/);
    return true;
  });
});

test('naming の confirmed が真偽値でなければ落ちる', () => {
  const raw = JSON.parse(readFileSync(resolveWorldConfigPath({}), 'utf8')) as Record<string, unknown>;
  const naming = raw['naming'] as Record<string, Record<string, unknown>>;
  naming['market'] = { ...naming['market'], confirmed: 'yes' };
  assert.throws(() => validateWorldConfig(raw, 'test-fixture'), /naming\.market\.confirmed/);
});
