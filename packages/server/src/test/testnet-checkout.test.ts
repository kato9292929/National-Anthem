import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { X402Config } from '@na/shared';
import { loadX402Config } from '@na/shared/node';
import { TestnetCheckout } from '../x402/testnet-checkout.js';
import { inspectSdkPayer } from '../x402/sdk-payer.js';

const base = loadX402Config({}).value;

/** base-sepolia レールを確定させた config を作る（テスト用・実 payTo は入れない）。 */
function withConfirmedBaseSepolia(): X402Config {
  return {
    ...base,
    rails: base.rails.map((r) =>
      r.id === 'base-sepolia' ? { ...r, confirmed: true, payTo: '0x0000000000000000000000000000000000000001' } : r,
    ),
  };
}

test('config に base-sepolia（Base Sepolia testnet）レールがある', () => {
  const rail = base.rails.find((r) => r.id === 'base-sepolia');
  assert.ok(rail, 'base-sepolia rail が config にある');
  assert.equal(rail!.chainKind, 'evm');
  assert.equal(rail!.network, 'eip155:84532');
  assert.equal(rail!.testnet, true);
  assert.equal(rail!.verified, false, '実 tx 確認まで verified は false');
  assert.equal(rail!.confirmed, false, 'payTo 未指定のうちは confirmed:false（区分A では回さない）');
  assert.ok(rail!.explorer?.includes('basescan'), 'エクスプローラ URL がある');
});

test('未確定のレールでは testnet 決済を回さない（偽の決済を作らない）', async () => {
  const checkout = new TestnetCheckout({
    config: base, // base-sepolia は confirmed:false
    railId: 'base-sepolia',
    sdkEnv: {},
    resourceUrl: 'http://127.0.0.1:59999/api/x402/paid-resource',
  });
  await assert.rejects(
    () => checkout.run({ resource: '/x', description: 'x', amount: '1000', buyerKind: 'human' }),
    /未確定/,
  );
});

test('資源に到達できなければ challenge で fail-loud（成功に見せない）', async () => {
  const checkout = new TestnetCheckout({
    config: withConfirmedBaseSepolia(),
    railId: 'base-sepolia',
    sdkEnv: { evmPrivateKey: '0x' + '1'.repeat(64) },
    // 誰も listen していないポート。到達できない。
    resourceUrl: 'http://127.0.0.1:59998/api/x402/paid-resource',
  });
  const result = await checkout.run({ resource: '/x', description: 'x', amount: '1000', buyerKind: 'human' });
  assert.equal(result.ok, false);
  assert.equal(result.failure?.stage, 'challenge');
  assert.ok(!result.steps.some((s) => s.step === 'settled'), 'settled は出ない');
});

test('EVM 鍵が無ければ実支払い口を作れない（inspectSdkPayer）', () => {
  const config = withConfirmedBaseSepolia();
  const none = inspectSdkPayer(config, {});
  assert.ok(none.missing.some((m) => m.includes('NA_EVM_PRIVATE_KEY')), '鍵不足を示す');
  const withKey = inspectSdkPayer(config, { evmPrivateKey: '0x' + '1'.repeat(64) });
  assert.ok(withKey.rails.includes('base-sepolia'), '鍵があれば base-sepolia で払える');
  assert.equal(withKey.available, true);
});
