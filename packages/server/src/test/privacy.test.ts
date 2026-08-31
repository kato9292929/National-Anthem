import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaymentLeg } from '@na/shared';
import { loadPrivacyConfig, loadX402Config } from '@na/shared/node';
import { MemoryEventLog } from '../store/event-log.js';
import { createMockMxe, PrivacyError, PrivateGateway } from '../privacy/gateway.js';
import { PaymentRecordStore } from '../privacy/records.js';
import { AddressLeakError, findAddresses } from '../privacy/redact.js';
import { withX402 } from '../x402/client.js';
import { FacilitatorClient } from '../x402/facilitator.js';
import { startMockFacilitator } from '../x402/mock/facilitator.js';
import { startMockResourceServer } from '../x402/mock/resource.js';
import { MockPaymentSigner } from '../x402/signer.js';

const privacyConfig = loadPrivacyConfig({}).value;
const x402Config = loadX402Config({}).value;
const leg: PaymentLeg = {
  scheme: 'native',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '10000',
  payTo: '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf',
};

test('config: ミキサーを実装しない・追跡不能化を謳わない', () => {
  assert.equal(privacyConfig.claims.mixer, false);
  assert.equal(privacyConfig.claims.untraceability, false);
  assert.match(privacyConfig.claims.claim_ja, /検証の機密化/);
  assert.deepEqual(privacyConfig.response.allowedFields, ['payment_valid']);
  assert.equal(privacyConfig.recording.walletAddressesAllowed, false);
  assert.equal(privacyConfig.gateway.verified, false, '実 MXE 投入は区分B');
  assert.equal(privacyConfig.gateway.source_repo, 'github.com/kato9292929/Arcium');
});

test('Gateway が返すのは payment_valid だけ', async () => {
  const gateway = new PrivateGateway(createMockMxe(), privacyConfig);
  assert.deepEqual(await gateway.verify({ payload: { any: 'thing' }, leg }), { payment_valid: true });
  assert.deepEqual(await new PrivateGateway(createMockMxe(() => false), privacyConfig).verify({ payload: {}, leg }), {
    payment_valid: false,
  });
});

test('許可外のフィールドが返ったら受け取らずに落ちる（黙って捨てない）', async () => {
  const leaky = { id: 'leaky', verify: () => Promise.resolve({ payment_valid: true, payer: 'x', amount: '10000' }) };
  await assert.rejects(
    new PrivateGateway(leaky, privacyConfig).verify({ payload: {}, leg }),
    (error: unknown) => {
      assert.ok(error instanceof PrivacyError);
      assert.match(error.message, /payer/);
      return true;
    },
  );
});

test('payment_valid が真偽値でない・応答がオブジェクトでない場合も落ちる', async () => {
  await assert.rejects(
    new PrivateGateway({ id: 'x', verify: () => Promise.resolve({ payment_valid: 'yes' }) }, privacyConfig).verify({
      payload: {},
      leg,
    }),
    /payment_valid（真偽値）が無い/,
  );
  await assert.rejects(
    new PrivateGateway({ id: 'x', verify: () => Promise.resolve(true) }, privacyConfig).verify({ payload: {}, leg }),
    /オブジェクトでない/,
  );
});

test('アドレス検査が EVM / Solana / mock を捕まえる', () => {
  assert.equal(findAddresses({ a: '0x' + 'a'.repeat(40) }).length, 1);
  assert.equal(findAddresses({ b: leg.payTo }).length, 1);
  assert.equal(findAddresses({ c: 'mock:feePayer:A' }).length, 1);
  assert.equal(findAddresses({ d: 'tick 42', e: 10000 }).length, 0);
});

test('決済記録にアドレスを入れようとすると落ちる', () => {
  const store = new PaymentRecordStore(new MemoryEventLog(), privacyConfig.recording);
  assert.throws(() => store.record({ payment_valid: true, ref: leg.payTo }), (error: unknown) => {
    assert.ok(error instanceof AddressLeakError);
    return true;
  });
  const ok = store.record({ payment_valid: true, ref: 'commission-0001' });
  assert.equal(ok.payment_valid, true);
  assert.equal(Object.keys(ok).sort().join(','), 'at,id,payment_valid,ref');
});

test('Gateway 経由で x402 が一周し、ログにアドレスが残らない', async () => {
  const facilitator = await startMockFacilitator();
  const facilitatorClient = new FacilitatorClient(facilitator.url);
  const log = new MemoryEventLog();
  const records = new PaymentRecordStore(log, privacyConfig.recording);
  const gateway = new PrivateGateway(
    {
      id: 'mock-mxe-over-facilitator',
      // MXE の中で検証する想定。外に出すのは bool だけ。
      verify: async (input) => ({
        payment_valid: (await facilitatorClient.verify(input.payload, input.leg)).isValid,
      }),
    },
    privacyConfig,
  );

  const resource = await startMockResourceServer({
    config: x402Config,
    railId: 'solana',
    nextFeePayer: facilitator.nextFeePayer,
    verifier: async ({ payload, leg: resourceLeg }) => {
      const verification = await gateway.verify({ payload, leg: resourceLeg });
      records.record({ payment_valid: verification.payment_valid, ref: 'smoke-commission' });
      return verification;
    },
    settle: async ({ payload, leg: resourceLeg }) => ({
      ...(await facilitatorClient.settle(payload, resourceLeg)),
    }),
  });

  try {
    const result = await withX402(
      `${resource.url}/paid`,
      { method: 'GET' },
      { config: x402Config, signers: [new MockPaymentSigner('solana', ['solana'])] },
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.payment?.settlement.success, true);

    const stored = records.all();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.payment_valid, true);
    assert.equal(findAddresses(log.readAll()).length, 0, 'ログにアドレスが残っている');
    assert.equal(JSON.stringify(log.readAll()).includes('10000'), false, 'ログに金額を残さない');
  } finally {
    await resource.close();
    await facilitator.close();
  }
});
