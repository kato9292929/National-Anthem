import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { seedFrom, type MarketState } from '@na/shared';
import { loadIdentityConfig, loadRoomsConfig, loadWorldConfig } from '@na/shared/node';
import { createHttpServer } from '../http.js';
import { IdentityService } from '../identity/service.js';
import { MarketSimulation } from '../market/simulation.js';

const { config, path } = loadWorldConfig({});
const identityConfig = loadIdentityConfig({}).value;
const roomsConfig = loadRoomsConfig({}).value;

async function withServer<T>(fn: (base: string, sim: MarketSimulation) => Promise<T>): Promise<T> {
  const sim = new MarketSimulation({ config, seed: seedFrom('http-test') });
  const identity = new IdentityService({ identityConfig, roomsConfig, seed: 11 });
  const localPlayerId = identity.createIdentity({ kind: 'human' }).id;
  identity.createSessionWallet(localPlayerId);
  const server = createHttpServer({
    config,
    configPath: path,
    sim,
    identity,
    roomsConfig,
    localPlayerId,
    x402Status: () => ({ mode: 'unavailable' }),
    paywall: {
      enabled: false,
      headerName: 'PAYMENT-SIGNATURE',
      guard: () => Promise.resolve({ kind: 'disabled' as const }),
    },
    privacyStatus: () => ({ mode: 'mock' }),
    agentStatus: () => ({ gate: { satisfied: false } }),
    adapterStatus: () => ({ adapters: [] }),
    presentationConfig: () => ({ config: { mode: 'greybox' } }),
    commissionBoard: () => ({ modules: { primary: 'commission-board' } }),
    commissionAction: () => Promise.resolve({ ok: true }),
    storefrontListing: () => ({ rank: 'secondary' }),
    storefrontBuy: () => ({ ok: true }),
    ledgerState: () => ({ credits: 0, inventory: [] }),
    checkoutStatus: () => ({ enabled: false, mode: 'disabled' }),
    storefrontCheckout: {
      enabled: false,
      run: () =>
        Promise.resolve({ ok: false, failure: null, receipt: null, ledger: null, standing: null, settlement: null }),
    },
    port: 0,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, sim);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test('GET /api/market/state が現在の market state を返す', async () => {
  await withServer(async (base, sim) => {
    sim.stepMany(10);
    const res = await fetch(`${base}/api/market/state`);
    assert.equal(res.status, 200);
    const state = (await res.json()) as MarketState;
    assert.equal(state.tick, 10);
    assert.equal(state.items.length, sim.items.length);
    assert.equal(state.states.length, sim.items.length);
  });
});

test('GET /api/world/config が config と解決済みの固有名を返す', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/world/config`);
    const body = (await res.json()) as {
      config: typeof config;
      names: Record<string, { display: string; confirmed: boolean }>;
      unconfirmedNames: string[];
    };
    assert.equal(body.config.stall_categories.imports.length, config.stall_categories.imports.length);
    assert.equal(body.names['market']!.confirmed, false);
    assert.match(body.names['market']!.display, /未確定/);
    assert.ok(body.unconfirmedNames.includes('market'));
  });
});

test('POST /api/market/shock が供給ショックのフックとして効く', async () => {
  await withServer(async (base, sim) => {
    const itemId = sim.items[0]!.id;
    const res = await fetch(`${base}/api/market/shock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId, supplyMultiplier: 0.2, durationTicks: 10, note: 'test' }),
    });
    assert.equal(res.status, 200);
    sim.step();
    const state = sim.state(0);
    assert.equal(state.states.find((s) => s.itemId === itemId)!.shock?.origin, 'manual');
  });
});

test('未知のパスは 404 を返す（黙って 200 を返さない）', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
  });
});

test('不正なショック要求はエラーを隠さず 500 で返す', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/market/shock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: 'nope', supplyMultiplier: 0.5, durationTicks: 5 }),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { message: string };
    assert.match(body.message, /nope/);
  });
});

test('GET /api/identity/session が identity・wallet・standing・room gate を返す', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/session`);
    const body = (await res.json()) as {
      identity: { id: string };
      wallet: { id: string; address: string };
      standing: { score: number };
      rooms: { id: string; gate: { allowed: boolean; provisional: boolean } }[];
    };
    assert.notEqual(body.wallet.id, body.identity.id, 'identity と wallet は別物');
    assert.ok(body.wallet.address.startsWith('mock:'));
    assert.equal(body.rooms.find((r) => r.id === 'market_floor')!.gate.allowed, true);
    assert.equal(body.rooms.find((r) => r.id === 'inner_room')!.gate.allowed, false);
    assert.equal(body.rooms.every((r) => r.gate.provisional), true, 'しきい値は仮値');
  });
});

test('評判が積まれると room gate が開き、wallet を rotate しても開いたまま', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/api/identity/reputation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'commission_completed', ref: `c-${i}` }),
      });
      assert.equal(res.status, 200);
    }
    const opened = (await (await fetch(`${base}/api/identity/session`)).json()) as {
      rooms: { id: string; gate: { allowed: boolean } }[];
      standing: { score: number };
    };
    assert.equal(opened.rooms.find((r) => r.id === 'inner_room')!.gate.allowed, true);

    await fetch(`${base}/api/identity/rotate`, { method: 'POST' });
    const afterRotate = (await (await fetch(`${base}/api/identity/session`)).json()) as {
      rooms: { id: string; gate: { allowed: boolean } }[];
      standing: { score: number };
      wallet: { address: string };
    };
    assert.equal(afterRotate.standing.score, opened.standing.score, 'rotate で評判は消えない');
    assert.equal(afterRotate.rooms.find((r) => r.id === 'inner_room')!.gate.allowed, true);
  });
});

test('未知の評判種別は握りつぶさずエラーになる', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/reputation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'no_such_kind' }),
    });
    assert.equal(res.status, 500);
  });
});
