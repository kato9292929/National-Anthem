import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaymentLeg } from '@na/shared';
import { loadX402Config } from '@na/shared/node';
import {
  assertNotExpired,
  encodeHeader,
  parseRequirements,
  parseSettlement,
  selectLeg,
  withX402,
  X402Error,
} from '../x402/client.js';
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
  options: {
    accept?: (payload: Record<string, unknown>) => boolean;
    settleSuccess?: boolean;
    expiresInMs?: number;
    omitFeePayer?: boolean;
  } = {},
): Promise<T> {
  const facilitator = await startMockFacilitator(
    options.accept ? { accept: options.accept } : {},
  );
  const client = new FacilitatorClient(facilitator.url);
  const resource = await startMockResourceServer({
    config,
    railId: 'solana',
    nextFeePayer: facilitator.nextFeePayer,
    ...(options.expiresInMs === undefined ? {} : { expiresInMs: options.expiresInMs }),
    ...(options.omitFeePayer === undefined ? {} : { omitFeePayer: options.omitFeePayer }),
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
  // リソース側は 200 を返さず、クライアント側も再送 402 をループさせずに落ちる。
  await withRig(
    async ({ resourceUrl }) => {
      const signers = [new MockPaymentSigner('solana', ['solana'])];
      await assert.rejects(withX402(resourceUrl, { method: 'GET' }, { config, signers }), (error: unknown) => {
        assert.ok(error instanceof X402Error);
        assert.match(error.message, /再送しても 402/);
        return true;
      });
    },
    { settleSuccess: false },
  );

  // settle 結果そのものを読む側でも、success:false は成功にしない。
  const failed = new Response('{}', {
    status: 200,
    headers: { 'X-PAYMENT-RESPONSE': encodeHeader({ success: false, errorReason: 'insufficient_funds' }) },
  });
  assert.equal(parseSettlement(failed, config).success, false);
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

test('feePayer が要るレールで 402 に入っていなければ払わない', async () => {
  await withRig(
    async ({ resourceUrl, facilitator }) => {
      await assert.rejects(
        withX402(resourceUrl, { method: 'GET' }, { config, signers: [new MockPaymentSigner('solana', ['solana'])] }),
        (error: unknown) => {
          assert.ok(error instanceof X402Error);
          assert.match(error.message, /extra\.feePayer が要るのに/);
          return true;
        },
      );
      assert.deepEqual(facilitator.calls, [], '署名も検証も走らせない');
    },
    { omitFeePayer: true },
  );
});

test('期限切れの 402 では署名しない', async () => {
  await withRig(
    async ({ resourceUrl, facilitator }) => {
      await assert.rejects(
        withX402(resourceUrl, { method: 'GET' }, { config, signers: [new MockPaymentSigner('solana', ['solana'])] }),
        /期限が切れている/,
      );
      assert.deepEqual(facilitator.calls, []);
    },
    { expiresInMs: -1000 },
  );
});

test('期限内の 402 は通る。期限が無い 402 は期限なしとして扱う', async () => {
  await withRig(
    async ({ resourceUrl }) => {
      const result = await withX402(
        resourceUrl,
        { method: 'GET' },
        { config, signers: [new MockPaymentSigner('solana', ['solana'])] },
      );
      assert.equal(result.response.status, 200);
    },
    { expiresInMs: 60_000 },
  );

  const noExpiry: PaymentLeg = { ...baseLeg(), amount: '10000' };
  assert.doesNotThrow(() => assertNotExpired(noExpiry, config));
  assert.throws(() => assertNotExpired({ ...noExpiry, expiresAt: 1 }, config, 2), /期限が切れている/);
  assert.equal(config.protocol.legExpiryConfirmed, false, '期限フィールドの位置は未確定');
});

test('同じ支払いを 2 回 settle しない（二重支払いを弾く）', async () => {
  await withRig(async ({ resourceUrl, facilitator }) => {
    const signers = [new MockPaymentSigner('solana', ['solana'])];
    // 1 回目の支払いで使ったヘッダを取り出して、そのまま再送する。
    let captured: string | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      const header = new Headers(init?.headers).get(config.protocol.paymentHeader);
      if (header) captured = header;
      return fetch(input, init);
    };
    const first = await withX402(resourceUrl, { method: 'GET' }, { config, signers, fetchImpl });
    assert.equal(first.payment?.settlement.success, true);
    assert.ok(captured);

    const replay = await fetch(resourceUrl, { headers: { [config.protocol.paymentHeader]: captured } });
    assert.equal(replay.status, 402, '再送が 200 で通っている');
    const body = (await replay.json()) as { error: string; detail: { errorReason: string } };
    assert.equal(body.error, 'settle_failed');
    assert.equal(body.detail.errorReason, 'payment_replayed');
    assert.equal(facilitator.calls.filter((c) => c.kind === 'settle').length, 2);
  });
});

test('レール不一致: ネットワークだけ / 資産だけ一致でも払わない', () => {
  const signers = [new MockPaymentSigner('solana', ['solana'])];
  const sameNetwork: PaymentLeg = { ...baseLeg(), asset: 'SomeOtherMint111111111111111111111111111' };
  const sameAsset: PaymentLeg = { ...baseLeg(), network: 'solana:devnet-not-configured' };
  for (const leg of [sameNetwork, sameAsset]) {
    assert.throws(
      () => selectLeg({ x402Version: 2, accepts: [leg] }, config, signers),
      /対応する rail が config に無い/,
    );
  }
});

test('payTo が config と違えば払わない', () => {
  const signers = [new MockPaymentSigner('solana', ['solana'])];
  const wrongPayTo: PaymentLeg = { ...baseLeg(), payTo: '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3AAA' };
  assert.throws(
    () => selectLeg({ x402Version: 2, accepts: [wrongPayTo] }, config, signers),
    /payTo が config と違う/,
  );
});

test('複数の leg が来たら、払えるレールだけを選ぶ', () => {
  const signers = [new MockPaymentSigner('solana', ['solana'])];
  const evmLeg: PaymentLeg = {
    scheme: 'native',
    network: 'eip155:8453',
    asset: '0xUSDC',
    amount: '10000',
    payTo: '0xsomewhere',
  };
  const selected = selectLeg({ x402Version: 2, accepts: [evmLeg, baseLeg()] }, config, signers);
  assert.equal(selected.rail.id, 'solana');
});

test('accepts が壊れている場合も既定値で補わない', () => {
  const cases: [unknown, RegExp][] = [
    [{ x402Version: 2, accepts: [{ scheme: 'native', network: 'x', asset: 'y', payTo: '', amount: '1' }] }, /payTo が空/],
    [{ x402Version: 2, accepts: ['not-an-object'] }, /オブジェクトでない/],
    [{ x402Version: 2 }, /accepts が空/],
  ];
  for (const [body, pattern] of cases) {
    assert.throws(
      () => parseRequirements(fakeResponse({ 'PAYMENT-REQUIRED': encodeHeader(body) }), config),
      pattern,
    );
  }
});

test('PAYMENT-REQUIRED が base64 でも生 JSON でも読め、壊れていれば落ちる', () => {
  const body = { x402Version: 2, accepts: [baseLeg()] };
  const raw = parseRequirements(fakeResponse({ 'PAYMENT-REQUIRED': JSON.stringify(body) }), config);
  const encoded = parseRequirements(fakeResponse({ 'PAYMENT-REQUIRED': encodeHeader(body) }), config);
  assert.deepEqual(raw, encoded);
  assert.throws(() => parseRequirements(fakeResponse({ 'PAYMENT-REQUIRED': 'not-base64-or-json' }), config), /読めない/);
});

test('settle 応答のヘッダが無い / 壊れていれば成功にしない', async () => {
  const withoutHeader: typeof fetch = async () =>
    new Response('{}', { status: 200 });
  await assert.rejects(
    withX402(
      'http://example.invalid/paid',
      {},
      {
        config,
        signers: [new MockPaymentSigner('solana', ['solana'])],
        fetchImpl: async (input, init) => {
          const header = new Headers(init?.headers).get(config.protocol.paymentHeader);
          if (!header) {
            return new Response('{}', {
              status: 402,
              headers: { 'PAYMENT-REQUIRED': encodeHeader({ x402Version: 2, accepts: [baseLeg()] }) },
            });
          }
          return withoutHeader(input, init);
        },
      },
    ),
    /X-PAYMENT-RESPONSE が無い/,
  );
});

function baseLeg(): PaymentLeg {
  return {
    scheme: 'native',
    network: solanaRail.network,
    asset: solanaRail.asset,
    amount: solanaRail.defaultAmount,
    payTo: solanaRail.payTo,
    extra: { feePayer: 'mock:feePayer:Z' },
  };
}
