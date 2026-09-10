import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedFrom } from '@na/shared';
import {
  loadCommissionConfig,
  loadIdentityConfig,
  loadMarketStructureConfig,
  loadPrivacyConfig,
  loadRoomsConfig,
  loadWorldConfig,
  loadX402Config,
} from '@na/shared/node';
import { IdentityService } from '../identity/service.js';
import { MarketSimulation } from '../market/simulation.js';
import { GoodsStorefront } from '../commission/storefront.js';
import { PlayerLedger } from '../store/ledger.js';
import { createMockMxe, PrivateGateway } from '../privacy/gateway.js';
import { createX402Service } from '../x402/service.js';
import { DemoCheckout } from '../x402/demo-checkout.js';
import { runStorefrontCheckout, CheckoutError } from '../commission/checkout.js';
import { MemoryEventLog } from '../store/event-log.js';

const { config } = loadWorldConfig({});
const identityConfig = loadIdentityConfig({}).value;
const roomsConfig = loadRoomsConfig({}).value;
const commissionConfig = loadCommissionConfig({}).value;
const x402Config = loadX402Config({}).value;
const privacyConfig = loadPrivacyConfig({}).value;
const structure = loadMarketStructureConfig({}).value;

function makeFixture(startingCreditsOverride?: number) {
  const log = new MemoryEventLog();
  const sim = new MarketSimulation({ config, seed: seedFrom('checkout-test'), structure });
  const identity = new IdentityService({ identityConfig, roomsConfig, log, seed: 7 });
  const buyer = identity.createIdentity({ kind: 'human' });
  identity.createSessionWallet(buyer.id);
  const storefront = new GoodsStorefront({ world: config, sim, log });
  const ledgerConfig =
    startingCreditsOverride === undefined
      ? commissionConfig.storefront
      : { ...commissionConfig.storefront, startingCredits: startingCreditsOverride };
  const ledger = new PlayerLedger({ config: ledgerConfig, log });
  const gateway = new PrivateGateway(createMockMxe(), privacyConfig);
  // mock 署名口（区分A）。
  const x402 = createX402Service(x402Config, { NA_X402_MOCK: '1' } as NodeJS.ProcessEnv);
  const demoCheckout = new DemoCheckout({ config: x402Config, railId: 'solana', signers: x402.signers, gateway });
  const deps = {
    storefront,
    ledger,
    identity,
    demoCheckout,
    settledReputationKind: commissionConfig.reputation.onSettled.principal as 'payment_settled',
  };
  const itemId = config.stall_categories.imports[0]!.id;
  return { deps, buyerId: buyer.id, itemId, ledger, identity, demoCheckout };
}

test('決済が settle まで通ると 4 段が実イベントとして流れ、手持ち・評判が動く', async () => {
  const f = makeFixture();
  const creditsBefore = f.ledger.state(f.buyerId).credits;
  const standingBefore = f.identity.standing(f.buyerId).score;

  const steps: string[] = [];
  const outcome = await runStorefrontCheckout(
    f.deps,
    { buyerId: f.buyerId, itemId: f.itemId, quantity: 1, resource: '/api/storefront/checkout' },
    (s) => steps.push(`${s.step}:${s.ok}`),
  );

  assert.deepEqual(steps, ['challenge:true', 'signed:true', 'verified:true', 'settled:true']);
  assert.equal(outcome.result.ok, true);
  assert.ok(outcome.receipt, 'receipt が出る');
  // tx は mock: / mock-tx-*、onChain は false（実チェーンに見せない）。
  const settled = outcome.result.steps.find((s) => s.step === 'settled')!;
  assert.equal(settled.detail['onChain'], false);
  assert.match(String(settled.detail['transaction']), /^mock-tx-/);
  // feePayer は 402 から動的に取れている（config のハードコードではない）。
  const challenge = outcome.result.steps.find((s) => s.step === 'challenge')!;
  assert.match(String(challenge.detail['feePayer']), /^mock:feePayer:/);

  // 手持ちが動く: credits が価格分だけ減り、inventory が 1 増える。
  const amount = Number(outcome.receipt!.amount);
  assert.equal(outcome.ledger!.credits, creditsBefore - amount);
  assert.equal(outcome.ledger!.inventory.find((i) => i.itemId === f.itemId)?.quantity, 1);
  // 買い手の standing が上がる（payment_settled）。
  assert.ok(outcome.standing!.score > standingBefore);

  await f.demoCheckout.close();
});

test('検証が通らなければ settled を出さず、手持ち・評判を動かさない（fail-loud）', async () => {
  const f = makeFixture();
  const creditsBefore = f.ledger.state(f.buyerId).credits;
  const standingBefore = f.identity.standing(f.buyerId).score;

  const steps: string[] = [];
  const outcome = await runStorefrontCheckout(
    f.deps,
    { buyerId: f.buyerId, itemId: f.itemId, quantity: 1, resource: '/api/storefront/checkout', simulateFailure: 'verify' },
    (s) => steps.push(`${s.step}:${s.ok}`),
  );

  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.receipt, null);
  assert.ok(!outcome.result.steps.some((s) => s.step === 'settled'), 'settled は出ない');
  assert.equal(outcome.result.failure?.stage, 'verify');
  // 状態は一切動かない。
  assert.equal(f.ledger.state(f.buyerId).credits, creditsBefore);
  assert.equal(f.identity.standing(f.buyerId).score, standingBefore);

  await f.demoCheckout.close();
});

test('清算が通らなければ settled を出さず、手持ちを動かさない（fail-loud）', async () => {
  const f = makeFixture();
  const creditsBefore = f.ledger.state(f.buyerId).credits;

  const outcome = await runStorefrontCheckout(
    f.deps,
    { buyerId: f.buyerId, itemId: f.itemId, quantity: 1, resource: '/api/storefront/checkout', simulateFailure: 'settle' },
  );

  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.failure?.stage, 'settle');
  assert.ok(!outcome.result.steps.some((s) => s.step === 'settled'));
  assert.equal(f.ledger.state(f.buyerId).credits, creditsBefore);

  await f.demoCheckout.close();
});

test('credits を超える購入は決済フローに入る前に落ちる（買えないのに 402 を出さない）', async () => {
  // credits 0 の買い手。在庫はあるが払えない。
  const f = makeFixture(0);
  const steps: string[] = [];
  await assert.rejects(
    () =>
      runStorefrontCheckout(
        f.deps,
        { buyerId: f.buyerId, itemId: f.itemId, quantity: 1, resource: '/api/storefront/checkout' },
        (s) => steps.push(s.step),
      ),
    (error: unknown) => error instanceof CheckoutError,
  );
  // 402 も署名も出ていない（フローに入る前に落ちている）。
  assert.deepEqual(steps, []);
  await f.demoCheckout.close();
});
