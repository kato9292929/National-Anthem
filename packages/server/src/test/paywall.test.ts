import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { seedFrom } from '@na/shared';
import { loadIdentityConfig, loadPrivacyConfig, loadRoomsConfig, loadWorldConfig, loadX402Config } from '@na/shared/node';
import { createHttpServer } from '../http.js';
import { IdentityService } from '../identity/service.js';
import { MarketSimulation } from '../market/simulation.js';
import { createDelegatingMxe, PrivateGateway } from '../privacy/gateway.js';
import {
  buildAccepts,
  buildRequirements,
  decodePaymentSignature,
  FeePayerResolver,
  matchRequirement,
} from '../x402/challenge.js';
import { withX402 } from '../x402/client.js';
import { FacilitatorClient } from '../x402/facilitator.js';
import { startMockFacilitator } from '../x402/mock/facilitator.js';
import { Paywall } from '../x402/paywall.js';
import { MockPaymentSigner } from '../x402/signer.js';

const config = loadX402Config({}).value;
const privacyConfig = loadPrivacyConfig({}).value;
const world = loadWorldConfig({});
const identityConfig = loadIdentityConfig({}).value;
const roomsConfig = loadRoomsConfig({}).value;

const challengeInput = {
  config,
  railId: 'solana',
  resource: 'https://example.invalid/api/commission/action',
  description: '委託の封印精算',
  feePayer: 'mock:feePayer:A',
};

test('402 の accepts は v1 leg と v2 leg を併記する（稼働プロダクトと同じ形）', () => {
  const accepts = buildAccepts(challengeInput);
  assert.equal(accepts.length, 2);

  const [v1, v2] = accepts as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(v1['network'], 'solana', 'v1 leg は bare network');
  assert.equal(v1['maxAmountRequired'], '10000');
  assert.equal(v1['amount'], undefined, 'v1 leg に amount は載せない');
  assert.equal(v2['network'], 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(v2['amount'], '10000');
  assert.equal(v2['maxAmountRequired'], undefined);

  for (const leg of accepts) {
    assert.equal(leg['scheme'], 'exact');
    assert.equal(leg['resource'], challengeInput.resource);
    assert.equal(leg['description'], challengeInput.description);
    assert.equal(leg['mimeType'], 'application/json');
    assert.equal(leg['maxTimeoutSeconds'], 300);
    assert.equal(leg['payTo'], '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf');
    assert.equal(leg['asset'], 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const extra = leg['extra'] as Record<string, unknown>;
    assert.equal(extra['resource'], challengeInput.resource);
    assert.equal(extra['feePayer'], 'mock:feePayer:A');
  }
});

test('feePayer が取れなくても accepts は空にしない', () => {
  const accepts = buildAccepts({ ...challengeInput, feePayer: null });
  assert.equal(accepts.length, 2);
  for (const leg of accepts) {
    const extra = leg['extra'] as Record<string, unknown>;
    assert.equal(extra['feePayer'], undefined, 'feePayer を捏造しない');
    assert.equal(extra['resource'], challengeInput.resource);
  }
});

test('未確定の rail では 402 を出さない', () => {
  assert.throws(() => buildAccepts({ ...challengeInput, railId: 'base' }), /未確定の rail/);
  assert.throws(() => buildAccepts({ ...challengeInput, railId: 'no-such-rail' }), /config に無い rail/);
});

test('feePayer は /supported から取り、TTL の間だけ握る', async () => {
  let calls = 0;
  let now = 0;
  const facilitator = {
    supportedFeePayer: async () => {
      calls += 1;
      return `mock:feePayer:${calls}`;
    },
  } as unknown as FacilitatorClient;
  const resolver = new FeePayerResolver(config, facilitator, () => now);

  assert.equal(await resolver.resolve(), 'mock:feePayer:1');
  assert.equal(await resolver.resolve(), 'mock:feePayer:1', 'TTL 内は取り直さない');
  now = config.feePayer.ttlMs + 1;
  assert.equal(await resolver.resolve(), 'mock:feePayer:2', 'TTL を過ぎたら取り直す');
});

test('/supported が落ちていても、古い値や既定値で埋めない', async () => {
  const failing = {
    supportedFeePayer: () => Promise.reject(new Error('unreachable')),
  } as unknown as FacilitatorClient;
  assert.equal(await new FeePayerResolver(config, failing).resolve(), null);
  assert.equal(await new FeePayerResolver(config, null).resolve(), null);
});

test('払った leg は、こちらが出した leg に突き合わせる', () => {
  const requirements = buildRequirements(challengeInput);
  const matched = matchRequirement(requirements, {
    accepted: { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
  });
  assert.equal(matched?.['network'], 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

  // 相手が主張する payTo や金額は使わない（こちらの leg を facilitator へ送る）。
  assert.equal(matched?.['payTo'], '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf');
  assert.equal(matchRequirement(requirements, { scheme: 'exact', network: 'eip155:8453' }), null);
  assert.equal(matchRequirement(requirements, {}), null);
});

test('壊れた PAYMENT-SIGNATURE は落とさず 402 にする', () => {
  assert.equal(decodePaymentSignature('not-base64-json'), null);
  assert.equal(decodePaymentSignature(Buffer.from('[]', 'utf8').toString('base64')), null);
});

async function withPaidServer<T>(
  fn: (base: string, facilitator: Awaited<ReturnType<typeof startMockFacilitator>>) => Promise<T>,
  options: { accept?: (payload: Record<string, unknown>) => boolean } = {},
): Promise<T> {
  const facilitator = await startMockFacilitator(options.accept ? { accept: options.accept } : {});
  const facilitatorClient = new FacilitatorClient(facilitator.url);
  const identity = new IdentityService({ identityConfig, roomsConfig, seed: 13 });
  const localPlayerId = identity.createIdentity({ kind: 'human' }).id;
  identity.createSessionWallet(localPlayerId);
  const sim = new MarketSimulation({ config: world.config, seed: seedFrom('paywall-test') });
  sim.stepMany(10);

  const paywall = new Paywall({
    config,
    railId: 'solana',
    feePayer: new FeePayerResolver(config, facilitatorClient),
    facilitator: facilitatorClient,
    // 検証は facilitator へ委ね、外に出るのは payment_valid だけ。
    gateway: new PrivateGateway(
      createDelegatingMxe('facilitator-backed', async ({ payload, leg }) => (await facilitatorClient.verify(payload, leg)).isValid),
      privacyConfig,
    ),
    enabled: true,
  });

  const server = createHttpServer({
    config: world.config,
    configPath: world.path,
    sim,
    identity,
    roomsConfig,
    localPlayerId,
    x402Status: () => ({}),
    adapterStatus: () => ({}),
    presentationConfig: () => ({}),
    privacyStatus: () => ({}),
    agentStatus: () => ({}),
    commissionBoard: () => ({}),
    commissionAction: () => Promise.resolve({ ok: true }),
    storefrontListing: () => ({ items: [] }),
    storefrontBuy: () => ({ ok: true, paid: true }),
    ledgerState: () => ({ credits: 0, inventory: [] }),
    storefrontCheckout: {
      enabled: false,
      run: () =>
        Promise.resolve({ ok: false, failure: null, receipt: null, ledger: null, standing: null, settlement: null }),
    },
    paywall: {
      enabled: paywall.enabled,
      headerName: config.protocol.paymentHeader,
      guard: (input) => paywall.guard(input),
    },
    port: 0,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, facilitator);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await facilitator.close();
  }
}

test('ゲートした資源: 未払いなら 402（body は {}、要求はヘッダ）', async () => {
  await withPaidServer(async (base) => {
    const res = await fetch(`${base}/api/storefront/buy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: 'timber', quantity: 1 }),
    });
    assert.equal(res.status, 402);
    assert.equal(await res.text(), '{}');
    const header = res.headers.get('PAYMENT-REQUIRED');
    assert.ok(header, 'PAYMENT-REQUIRED が無い');
    const requirements = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      x402Version: number;
      accepts: Record<string, unknown>[];
    };
    assert.equal(requirements.x402Version, 2);
    assert.equal(requirements.accepts.length, 2);
    assert.equal((requirements.accepts[0]!['extra'] as Record<string, unknown>)['feePayer'], 'mock:feePayer:A');
  });
});

test('ゲートした資源: 払えば通る（我々の資源に対する 402 → 再送 → settle の一周）', async () => {
  await withPaidServer(async (base, facilitator) => {
    const result = await withX402(
      `${base}/api/storefront/buy`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'timber', quantity: 1 }),
      },
      { config, signers: [new MockPaymentSigner('solana', ['solana'])] },
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.payment?.leg.legVersion, 2, '払うのは v2 leg');
    assert.deepEqual(
      facilitator.calls.map((c) => c.kind),
      ['verify', 'settle'],
      '検証は Gateway 経由、settle は facilitator',
    );
    // facilitator へ渡す wire に x402Version が載っている（@x402/core と同じ形）。
    assert.equal(facilitator.calls[0]!.body['x402Version'], 2);
  });
});

test('ゲートした資源: 検証が通らなければ 200 を返さない', async () => {
  await withPaidServer(
    async (base) => {
      const res = await fetch(`${base}/api/storefront/buy`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [config.protocol.paymentHeader]: Buffer.from(
            JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payload: {} }),
            'utf8',
          ).toString('base64'),
        },
        body: JSON.stringify({ itemId: 'timber', quantity: 1 }),
      });
      assert.equal(res.status, 402, '検証に失敗したのに通している');
      const response = res.headers.get('PAYMENT-RESPONSE');
      assert.ok(response, 'PAYMENT-RESPONSE が無い');
      const decoded = JSON.parse(Buffer.from(response, 'base64').toString('utf8')) as Record<string, unknown>;
      assert.equal(decoded['success'], false);
      assert.equal(decoded['stage'], 'verify');
    },
    { accept: () => false },
  );
});
