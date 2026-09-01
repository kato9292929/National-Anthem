import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadIdentityConfig, loadRoomsConfig } from '@na/shared/node';
import { IdentityService, MOCK_ADDRESS_PREFIX } from '../identity/service.js';
import { FileEventLog, MemoryEventLog } from '../store/event-log.js';

const identityConfig = loadIdentityConfig({}).value;
const roomsConfig = loadRoomsConfig({}).value;

function service(log = new MemoryEventLog()): IdentityService {
  return new IdentityService({ identityConfig, roomsConfig, log, seed: 7 });
}

test('config の外部資産は確定値・未検証（区分B）として読める', () => {
  const ids = identityConfig.external_assets.erc8004.map((e) => `${e.chain}:${e.agentId}`);
  assert.deepEqual(ids, ['base:55560', 'arc-testnet:845265']);
  for (const asset of [
    ...identityConfig.external_assets.erc8004,
    ...identityConfig.external_assets.signers,
    ...identityConfig.external_assets.custodial_wallets,
  ]) {
    assert.equal(asset.confirmed, true, `${asset.id} は確定値`);
    assert.equal(asset.verified, false, `${asset.id} は実照会が未消化（区分B）`);
  }
});

test('identity と wallet は別物。wallet を差し替えても identity は変わらない', () => {
  const s = service();
  const player = s.createIdentity({ kind: 'human', externalRefs: ['base'] });
  const wallet = s.createSessionWallet(player.id);
  assert.notEqual(wallet.id, player.id);
  assert.equal(wallet.identityId, player.id);
  assert.ok(wallet.address.startsWith(MOCK_ADDRESS_PREFIX), '実チェーンのアドレスに見せない');
  assert.equal(wallet.verified, false);

  const rotated = s.rotateWallet(wallet.id);
  assert.equal(s.identity(player.id).id, player.id);
  assert.notEqual(rotated.address, wallet.address);
  assert.equal(rotated.rotatedFrom, wallet.id);
  assert.equal(s.walletsOf(player.id).find((w) => w.id === wallet.id)?.status, 'revoked');
});

test('rotate / revoke しても評判は残る', () => {
  const s = service();
  const agent = s.createIdentity({ kind: 'agent' });
  const wallet = s.createSessionWallet(agent.id);
  s.recordReputation({ identityId: agent.id, kind: 'commission_completed', ref: 'c-1' });
  s.recordReputation({ identityId: agent.id, kind: 'payment_settled', ref: 'p-1' });
  const before = s.standing(agent.id);

  s.rotateWallet(wallet.id);
  s.revokeWallet(s.activeWallet(agent.id)!.id, 'test');
  const after = s.standing(agent.id);

  assert.equal(after.score, before.score);
  assert.equal(after.impressions.total, 2);
  assert.equal(identityConfig.session_wallet.rotate_keeps_reputation, true);
});

test('standing は押印の履歴から積み上がり、上下限で止まる', () => {
  const s = service();
  const id = s.createIdentity({ kind: 'human' }).id;
  assert.equal(s.standing(id).score, identityConfig.standing.initial);

  for (let i = 0; i < 20; i++) s.recordReputation({ identityId: id, kind: 'commission_completed' });
  assert.equal(s.standing(id).score, identityConfig.standing.max);

  for (let i = 0; i < 20; i++) s.recordReputation({ identityId: id, kind: 'counterparty_vanished' });
  assert.equal(s.standing(id).score, identityConfig.standing.min);
  assert.equal(s.standing(id).impressions.negative, 20);
});

test('standing が room の開閉に効く。しきい値が仮値なら provisional で返る', () => {
  const s = service();
  const id = s.createIdentity({ kind: 'human' }).id;
  const floor = s.canEnter(id, 'market_floor');
  assert.equal(floor.allowed, true);
  assert.equal(floor.provisional, true, 'gate_confirmed:false なので仮値と伝える');

  const inner = s.canEnter(id, 'inner_room');
  assert.equal(inner.allowed, false);
  // 押印がまだ無いので、点数の前に実績の量で閉じる。
  assert.equal(inner.reason, 'insufficient_impressions');
  assert.equal(inner.requirements.minImpressions, 3);

  for (let i = 0; i < 5; i++) s.recordReputation({ identityId: id, kind: 'commission_completed' });
  assert.equal(s.canEnter(id, 'inner_room').allowed, true);
  assert.equal(s.canEnter(id, 'sealed_room').allowed, false);
});

test('未知の identity / room は握りつぶさない', () => {
  const s = service();
  assert.throws(() => s.canEnter('nope', 'no-such-room'), /no-such-room/);
  assert.equal(s.canEnter('nope', 'inner_room').reason, 'unknown_identity');
  assert.throws(() => s.createIdentity({ kind: 'agent', externalRefs: ['no-such-asset'] }), /no-such-asset/);
});

test('永続化: 再起動しても identity・wallet 系譜・評判が続く', () => {
  const dir = mkdtempSync(join(tmpdir(), 'na-identity-'));
  const path = join(dir, 'identity.jsonl');
  try {
    const first = new IdentityService({ identityConfig, roomsConfig, log: new FileEventLog(path), seed: 7 });
    const id = first.createIdentity({ kind: 'human' }).id;
    const wallet = first.createSessionWallet(id);
    first.recordReputation({ identityId: id, kind: 'commission_completed' });
    const rotated = first.rotateWallet(wallet.id);

    const reopened = new IdentityService({ identityConfig, roomsConfig, log: new FileEventLog(path), seed: 7 });
    assert.equal(reopened.standing(id).score, first.standing(id).score);
    assert.equal(reopened.activeWallet(id)?.id, rotated.id);
    assert.equal(reopened.activeWallet(id)?.rotatedFrom, wallet.id);
    assert.equal(reopened.walletsOf(id).filter((w) => w.status === 'revoked').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('壊れたイベントログは黙って読み飛ばさない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'na-identity-'));
  const path = join(dir, 'broken.jsonl');
  try {
    const log = new FileEventLog(path);
    log.append('identity_created', { identity: { id: 'x' } });
    appendFileSync(path, '{壊れた行\n');
    assert.throws(() => new FileEventLog(path), /壊れている/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('古い押印ほど効きが薄れる（半減期は仮値）', () => {
  const day = 24 * 60 * 60 * 1000;
  let now = 0;
  const s = new IdentityService({
    identityConfig,
    roomsConfig,
    log: new MemoryEventLog(),
    seed: 7,
    now: () => now,
  });
  const id = s.createIdentity({ kind: 'human' }).id;
  s.recordReputation({ identityId: id, kind: 'commission_completed' });
  const fresh = s.standing(id);
  assert.equal(fresh.breakdown.decayedWeight, fresh.breakdown.rawWeight, '直後は減衰しない');

  now = identityConfig.standing.policy.halfLifeDays * day;
  const aged = s.standing(id);
  assert.ok(aged.score < fresh.score, '時間が経っても効きが変わっていない');
  assert.ok(
    Math.abs(aged.breakdown.decayedWeight - aged.breakdown.rawWeight / 2) < 0.01,
    `半減期で半分にならない: ${aged.breakdown.decayedWeight}`,
  );
  assert.equal(aged.breakdown.provisional, true);
});

test('直近の重大事故は点数に関わらず門を閉じる', () => {
  const day = 24 * 60 * 60 * 1000;
  let now = 0;
  const s = new IdentityService({
    identityConfig,
    roomsConfig,
    log: new MemoryEventLog(),
    seed: 7,
    now: () => now,
  });
  const id = s.createIdentity({ kind: 'human' }).id;
  for (let i = 0; i < 12; i++) s.recordReputation({ identityId: id, kind: 'commission_completed' });
  assert.equal(s.canEnter(id, 'inner_room').allowed, true);

  s.recordReputation({ identityId: id, kind: 'counterparty_vanished', ref: 'c-9' });
  const blocked = s.canEnter(id, 'inner_room');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'recent_severe_event');
  assert.equal(s.standing(id).breakdown.recentSevere.length, 1);

  // 直近窓を抜ければ、点数が足りている限り再び開く。
  now = (identityConfig.standing.policy.recentWindowDays + 1) * day;
  const later = s.canEnter(id, 'inner_room');
  assert.equal(later.reason === 'recent_severe_event', false, '窓を抜けても塞がれている');
});

test('点数が足りていても押印が少なければ上の間には入れない', () => {
  const s = service();
  const id = s.createIdentity({ kind: 'human' }).id;
  // 重い加点 1 件だけで点数を作る。
  for (let i = 0; i < 3; i++) s.recordReputation({ identityId: id, kind: 'commission_completed' });
  const sealed = s.canEnter(id, 'sealed_room');
  assert.equal(sealed.allowed, false);
  assert.equal(sealed.reason, 'insufficient_impressions');
  assert.equal(sealed.impressions, 3);
  assert.ok(sealed.requirements.minImpressions > 3);
});

test('gate の判定条件は仮値として返る（policy が未確定な間は provisional）', () => {
  assert.equal(identityConfig.standing.policy.confirmed, false);
  const s = service();
  const id = s.createIdentity({ kind: 'human' }).id;
  for (const room of roomsConfig.rooms) {
    assert.equal(s.canEnter(id, room.id).provisional, true, `${room.id} が確定扱いになっている`);
  }
});
