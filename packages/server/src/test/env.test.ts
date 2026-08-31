import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvError } from '@na/shared';
import { CURRENT_MILESTONE, ENV_SPECS, isRequiredNow, resolveEnv } from '../env.js';

test('必須 env が無ければ明示して停止する', () => {
  assert.throws(() => resolveEnv({}, CURRENT_MILESTONE), (error: unknown) => {
    assert.ok(error instanceof EnvError);
    assert.match(error.message, /NA_MARKET_SEED/);
    assert.match(error.message, /未設定/);
    assert.match(error.message, /\.env\.example/);
    return true;
  });
});

test('空文字は「設定済み」と見なさない', () => {
  assert.throws(() => resolveEnv({ NA_MARKET_SEED: '' }, CURRENT_MILESTONE), /NA_MARKET_SEED/);
});

test('必須が揃えば通り、後続マイルストーンのキーは未設定のまま一覧に残る', () => {
  const env = resolveEnv({ NA_MARKET_SEED: 'test-seed' }, CURRENT_MILESTONE);
  assert.equal(env.require('NA_MARKET_SEED'), 'test-seed');
  assert.equal(env.get('NA_SERVER_PORT'), '8787');
  const llm = env.pending.find((p) => p.key === 'NA_LLM_API_KEY');
  assert.ok(llm, 'M6 のキーが pending に載っている');
  assert.equal(llm.set, false);
  assert.equal(llm.provisional, true);
});

test('M0〜M2 の必須に secret は含まれない（課金要素ゼロ）', () => {
  const requiredSecrets = ENV_SPECS.filter((s) => isRequiredNow(s) && s.secret);
  assert.deepEqual(requiredSecrets, []);
});
