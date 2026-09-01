import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterNotConfiguredError } from '../adapters/types.js';
import { createAdapterRegistry } from '../adapters/registry.js';
import {
  mockChainAdapter,
  mockCustodialWalletAdapter,
  mockErc8004Adapter,
  mockMxeAdapter,
} from '../adapters/mock.js';

/** 区分B の下ごしらえ: interface と mock はあるが、実接続は未消化。 */

test('どの口も verified:false（実接続の確認は区分B）', () => {
  const registry = createAdapterRegistry({ forceMock: true });
  for (const status of registry.statuses()) {
    assert.equal(status.verified, false, `${status.id} が検証済みになっている`);
    assert.ok(status.requires.length > 0, `${status.id} に必要なものが書かれていない`);
    assert.ok(status.note.length > 0);
  }
});

test('mock はもっともらしい偽値を返さない（mock: を残し onChain は false）', async () => {
  const record = await mockErc8004Adapter().lookupAgent({ chain: 'base', agentId: '55560' });
  assert.equal(record.onChain, false);
  assert.match(record.owner, /^mock:/);
  assert.equal(record.registeredAt, null, '登録時刻をでっち上げない');

  const wallet = await mockCustodialWalletAdapter().getWallet('dcw-evm-base');
  assert.equal(wallet.onChain, false);
  assert.match(wallet.address, /^mock:/);

  const balance = await mockChainAdapter().getBalance({ address: 'mock:wallet:x', asset: 'USDC' });
  assert.equal(balance.amount, '0', '残高をでっち上げない');
  assert.equal(balance.onChain, false);

  const tx = await mockChainAdapter().getTransaction('mock-tx-1');
  assert.equal(tx.confirmed, false);

  assert.deepEqual(await mockMxeAdapter().verify({ payload: {}, leg: {} as never }), { payment_valid: true });
  assert.deepEqual(await mockMxeAdapter(() => false).verify({ payload: {}, leg: {} as never }), {
    payment_valid: false,
  });
});

test('未接続の口は呼ばれたら落ちる。何が要るかをメッセージに載せる', async () => {
  const registry = createAdapterRegistry({});
  await assert.rejects(
    registry.erc8004.lookupAgent({ chain: 'base', agentId: '55560' }),
    (error: unknown) => {
      assert.ok(error instanceof AdapterNotConfiguredError);
      assert.match(error.message, /区分B/);
      assert.match(error.message, /ERC-8004 レジストリの呼び出し形/);
      return true;
    },
  );
  await assert.rejects(registry.custodialWallet.getWallet('dcw-solana'), /Circle DCW の資格情報/);
  await assert.rejects(registry.chain.getBalance({ address: 'x', asset: 'y' }), /チェーン RPC エンドポイント/);
});

test('env が揃えば live に向くが、検証済みにはならない', () => {
  const registry = createAdapterRegistry({
    facilitatorUrl: 'https://facilitator.payai.network',
    mxeUrl: 'https://mxe.example',
  });
  const facilitator = registry.facilitator.status();
  const mxe = registry.mxe.status();
  assert.equal(facilitator.mode, 'live');
  assert.equal(facilitator.verified, false);
  assert.match(facilitator.note, /未検証/);
  assert.equal(mxe.mode, 'live');
  assert.equal(mxe.verified, false);
});

test('forceMock なら env があっても mock を使う', () => {
  const registry = createAdapterRegistry({
    facilitatorUrl: 'https://facilitator.payai.network',
    mxeUrl: 'https://mxe.example',
    forceMock: true,
  });
  assert.deepEqual(
    registry.statuses().map((s) => s.mode),
    ['mock', 'mock', 'mock', 'mock', 'mock'],
  );
});
