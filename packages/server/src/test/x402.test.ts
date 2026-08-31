import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaymentLeg } from '@na/shared';
import { loadX402Config } from '@na/shared/node';
import { encodeHeader, parseRequirements, selectLeg, withX402, X402Error } from '../x402/client.js';
import { FacilitatorClient } from '../x402/facilitator.js';
import { startMockFacilitator } from '../x402/mock/facilitator.js';
import { startMockResourceServer } from '../x402/mock/resource.js';
import { MockPaymentSigner, unavailableSigner } from '../x402/signer.js';

const config = loadX402Config({}).value;
const solanaRail = config.rails.find((r) => r.id === 'solana')!;

test('確定値が config どおりに入っている', () => {
  assert.equal(config.protocol.x402Version, 2);
  assert.equal(config.protocol.scheme, 'native');
  assert.equal(config.protocol.requirementsHeader, 'PAYMENT-REQUIRED');
  assert.equal(config.protocol.legAmountField, 'amount');
  assert.equal(config.facilitator.url, 'https://facilitator.payai.network');
  assert.equal(config.facilitator.verified, false, '実 facilitator 疎通は区分B');
  assert.equal(solanaRail.asset, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(solanaRail.network, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(solanaRail.payTo, '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf');
  assert.equal(solanaRail.defaultAmount, '10000', '0.01 USDC = 10000（6 桁）');
  assert.equal(solanaRail.decimals, 6);

  const base = config.rails.find((r) => r.id === 'base')!;
  assert.equal(base.eip712Domain?.name, 'USD Coin', '"USDC" にしない');
  assert.equal(base.eip712Domain?.version, '2');
  assert.equal(base.confirmed, false, 'Base の payTo / asset は未確定なので TBD のまま');
});

test('feePayer は config に持たない（ハードコード禁止）', () => {
  const raw = JSON.stringify(config);
  assert.equal(config.feePayer.hardcodedAllowed, false);
  assert.equal(config.feePayer.source, 'response.accepts[].extra.feePayer');
  for (const rail of config.rails) {
    assert.equal((rail as unknown as Record<string, unknown>)['feePayer'], undefined);
  }
  assert.ok(!raw.includes('"feePayer":"'), 'config に feePayer の実値を置かない');
});

async function withRig<T>(
  fn: (rig: {
    resourceUrl: string;
    facilitator: Awaited<ReturnType<typeof startMockFacilitator>>;
    resource: Awaited<ReturnType<typeof startMockResourceServer>>;
  }) => Promise<T>,
  options: { accept?: (payload: Record<string, unknown>) => boolean; settleSuccess?: boolean } = {},
): Promise<T> {
  const facilitator = await startMockFacilitator(
    options.accept ? { accept: options.accept } : {},
  );
  const client = new FacilitatorClient(facilitator.url);
  const resource = await startMockResourceServer({
    config,
    railId: 'solana',
    nextFeePayer: facilitator.nextFeePayer,
    verifier: async ({ payload, leg }) => ({
      payment_valid: (await client.verify(payload, leg)).isValid,
    }),
    settle: async ({ payload, leg }) => {
      const result = await client.settle(payload, leg);
      const out: Record<string, unknown> = { ...result };
      if (options.settleSuccess === false) out['success'] = false;
      return out;
    },
  });
  try {
    return await fn({ resourceUrl: `${resource.url}/paid`, facilitator, resource });
  } finally {
    await resource.close();
    await facilitator.close();
  }
}

test('402 → X-PAYMENT 再送 → settle が一周する', async () => {
  await withRig(async ({ resourceUrl, facilitator }) => {
    const signers = [new MockPaymentSigner('solana', ['solana'])];
    const result = await withX402(resourceUrl, { method: 'GET' }, { config, signers });

    assert.equal(result.response.status, 200);
    assert.equal(result.payment?.railId, 'solana');
    assert.equal(result.payment?.leg.amount, '10000');
    assert.equal(result.payment?.settlement.success, true);
    assert.match(String(result.payment?.settlement.transaction), /^mock-tx-/);
    assert.deepEqual(
      facilitator.calls.map((c) => c.kind),
      ['verify', 'settle'],
    );
  });
});

test('feePayer は毎回 402 の extra から取る（ローテートに追随する）', async () => {
  await withRig(async ({ resourceUrl, facilitator, resource }) => {
    const signers = [new MockPaymentSigner('solana', ['solana'])];
    const first = await withX402(resourceUrl, { method: 'GET' }, { config, signers });
    const second = await withX402(resourceUrl, { method: 'GET' }, { config, signers });

    assert.notEqual(first.payment?.feePayer, second.payment?.feePayer, 'feePayer が固定されている');
    assert.deepEqual(
      [first.payment?.feePayer, second.payment?.feePayer],
      resource.challenges.map((c) => c.feePayer),
    );
    const sentFeePayers = facilitator.calls
      .filter((c) => c.kind === 'verify')
      .map((c) => ((c.body['paymentPayload'] as Record<string, unknown>)['payload'] as Record<string, unknown>)['feePayer']);
    assert.deepEqual(sentFeePayers, resource.challenges.map((c) => c.feePayer));
  });
});

test('資産が違うレールへ振り替えない（bridge しない）', () => {
  const baseLeg: PaymentLeg = {
    scheme: 'native',
    network: 'eip155:8453',
    asset: '0xUSDC',
    amount: '10000',
    payTo: '0xsomewhere',
  };
  const signers = [new MockPaymentSigner('solana', ['solana'])];
  assert.throws(
    () => selectLeg({ x402Version: 2, accepts: [baseLeg] }, config, signers),
    (error: unknown) => {
      assert.ok(error instanceof X402Error);
      assert.match(error.message, /bridge はしない/);
      return true;
    },
  );
});

test('未確定レールの署名口は黙って通らず落ちる', async () => {
  const base = config.rails.find((r) => r.id === 'base')!;
  const signer = unavailableSigner(base, '実鍵は区分B');
  await assert.rejects(
    signer.sign({ leg: {} as PaymentLeg, rail: base, feePayer: null, resourceUrl: 'x' }),
    /署名鍵が無い/,
  );
});

test('v1 の形（maxAmountRequired）は v2 として受け取らない', () => {
  const response = fakeResponse({
    'PAYMENT-REQUIRED': encodeHeader({
      x402Version: 2,
      accepts: [{ scheme: 'native', network: solanaRail.network, asset: solanaRail.asset, payTo: solanaRail.payTo, maxAmountRequired: '10000' }],
    }),
  });
  assert.throws(() => parseRequirements(response, config), /maxAmountRequired/);
});

test('x402Version が違う・ヘッダが無い場合は落ちる', () => {
  assert.throws(
    () => parseRequirements(fakeResponse({ 'PAYMENT-REQUIRED': encodeHeader({ x402Version: 1, accepts: [] }) }), config),
    /x402Version が想定外/,
  );
  assert.throws(() => parseRequirements(fakeResponse({}), config), /PAYMENT-REQUIRED ヘッダが無い/);
});

test('verify が通らなければ再送 402 でループさせずに落ちる', async () => {
  await withRig(
    async ({ resourceUrl }) => {
      const signers = [new MockPaymentSigner('solana', ['solana'])];
      await assert.rejects(
        withX402(resourceUrl, { method: 'GET' }, { config, signers }),
        /再送しても 402/,
      );
    },
    { accept: () => false },
  );
});

test('settle が成功しなければ成功として扱わない', async () => {
  await withRig(
    async ({ resourceUrl }) => {
      const signers = [new MockPaymentSigner('solana', ['solana'])];
      await assert.rejects(withX402(resourceUrl, { method: 'GET' }, { config, signers }), /settle が成功しなかった/);
    },
    { settleSuccess: false },
  );
});

test('402 でなければ支払わずにそのまま返す', async () => {
  const result = await withX402(
    'http://example.invalid/free',
    {},
    {
      config,
      signers: [],
      fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
    },
  );
  assert.equal(result.payment, null);
  assert.equal(result.response.status, 200);
});

function fakeResponse(headers: Record<string, string>): Response {
  return new Response('{}', { status: 402, headers });
}
