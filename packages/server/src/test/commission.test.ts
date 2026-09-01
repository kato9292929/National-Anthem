import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { seedFrom } from '@na/shared';
import { loadCommissionConfig, loadIdentityConfig, loadRoomsConfig, loadWorldConfig } from '@na/shared/node';
import { CommissionBoard, CommissionError } from '../commission/board.js';
import { EscrowError } from '../commission/escrow.js';
import { GoodsStorefront, StorefrontError } from '../commission/storefront.js';
import { IdentityService } from '../identity/service.js';
import { MarketSimulation } from '../market/simulation.js';
import { PaymentRecordStore } from '../privacy/records.js';
import { findAddresses } from '../privacy/redact.js';
import { MemoryEventLog } from '../store/event-log.js';

const commissionConfig = loadCommissionConfig({}).value;
const world = loadWorldConfig({}).config;
const identityConfig = loadIdentityConfig({}).value;
const roomsConfig = loadRoomsConfig({}).value;

interface Rig {
  board: CommissionBoard;
  identity: IdentityService;
  log: MemoryEventLog;
  principalId: string;
  agentId: string;
  arbiterId: string;
  itemId: string;
  partnerId: string;
}

function rig(): Rig {
  const log = new MemoryEventLog();
  const identity = new IdentityService({ identityConfig, roomsConfig, seed: 3 });
  const principalId = identity.createIdentity({ kind: 'human' }).id;
  const agentId = identity.createIdentity({ kind: 'agent', principalId }).id;
  const arbiterId = identity.createIdentity({ kind: 'human' }).id;
  const board = new CommissionBoard({
    config: commissionConfig,
    world,
    identity,
    log,
    paymentRecords: new PaymentRecordStore(log, { walletAddressesAllowed: false, amountsAllowed: false, endpointsAllowed: false }),
  });
  return {
    board,
    identity,
    log,
    principalId,
    agentId,
    arbiterId,
    itemId: world.stall_categories.imports[0]!.id,
    partnerId: world.trade_partners[0]!.id,
  };
}

function openAndAgree(r: Rig) {
  const commission = r.board.open({
    principalId: r.principalId,
    itemId: r.itemId,
    quantity: 3,
    amount: '10000',
    legs: [{ partnerId: r.partnerId, note: '往路' }],
  });
  r.board.proposeAgent(commission.id, r.agentId);
  r.board.agree(commission.id, r.principalId);
  return r.board.agree(commission.id, r.agentId);
}

test('config: 主は commission-board、副は goods-storefront。flow は未確定のまま', () => {
  assert.equal(commissionConfig.modules.primary, 'commission-board');
  assert.equal(commissionConfig.modules.secondary, 'goods-storefront');
  assert.equal(commissionConfig.flow.confirmed, false);
  assert.deepEqual(
    [commissionConfig.flow.legs, commissionConfig.flow.remote_handling, commissionConfig.flow.settlement_unit],
    ['TBD', 'TBD', 'TBD'],
  );
  assert.equal(commissionConfig.escrow.unit, 'TBD');
  assert.deepEqual(commissionConfig.arbitration.outcomes, ['release', 'refund']);
});

test('締結は両者合意でのみ確定する', () => {
  const r = rig();
  const commission = r.board.open({
    principalId: r.principalId,
    itemId: r.itemId,
    quantity: 1,
    amount: '10000',
    legs: [{ partnerId: r.partnerId }],
  });
  assert.equal(commission.state, 'open');
  assert.equal(commission.provisional, true, 'commission_flow が未確定なので仮の条件');

  r.board.proposeAgent(commission.id, r.agentId);
  const half = r.board.agree(commission.id, r.principalId);
  assert.equal(half.state, 'open', '片方だけでは締結しない');

  const both = r.board.agree(commission.id, r.agentId);
  assert.equal(both.state, 'agreed');
  assert.throws(() => r.board.agree(commission.id, r.arbiterId), /当事者でない/);
});

test('締結前に escrow は積まない', () => {
  const r = rig();
  const commission = r.board.open({
    principalId: r.principalId,
    itemId: r.itemId,
    quantity: 1,
    amount: '10000',
    legs: [{ partnerId: r.partnerId }],
  });
  assert.throws(() => r.board.fund(commission.id), /締結前に escrow は積まない/);
});

test('release: 納品 → 封印精算（payment_valid）→ escrow release → standing に反映', () => {
  const r = rig();
  const agreed = openAndAgree(r);
  const before = r.identity.standing(r.agentId).score;

  r.board.fund(agreed.id);
  assert.equal(r.board.escrow.get(agreed.id)?.state, 'held');
  const delivered = r.board.completeLeg(agreed.id, 0, 'done');
  assert.equal(delivered.state, 'delivered');

  const settled = r.board.settle(agreed.id, { paymentValid: true });
  assert.equal(settled.state, 'settled');
  assert.equal(r.board.escrow.get(agreed.id)?.state, 'released');
  assert.ok(r.identity.standing(r.agentId).score > before, 'commission 完了が standing に積まれる');
  assert.equal(
    r.identity.reputationOf(r.agentId).at(-1)?.kind,
    commissionConfig.reputation.onSettled.agent,
  );
});

test('payment_valid が false / 無い場合は release しない', () => {
  const r = rig();
  const agreed = openAndAgree(r);
  r.board.fund(agreed.id);
  r.board.completeLeg(agreed.id, 0, 'done');
  assert.throws(() => r.board.settle(agreed.id, { paymentValid: false }), (error: unknown) => {
    assert.ok(error instanceof EscrowError);
    assert.match(error.message, /payment_valid が false/);
    return true;
  });
  assert.equal(r.board.escrow.get(agreed.id)?.state, 'held', '失敗しても escrow は開かない');
});

test('refund: 不履行なら払い戻し、代理人の standing が下がる', () => {
  const r = rig();
  const agreed = openAndAgree(r);
  r.board.fund(agreed.id);
  const before = r.identity.standing(r.agentId).score;

  const refunded = r.board.refundForNonDelivery(agreed.id, '代理人が戻らない');
  assert.equal(refunded.state, 'refunded');
  assert.equal(r.board.escrow.get(agreed.id)?.state, 'refunded');
  assert.ok(r.identity.standing(r.agentId).score < before);
  assert.throws(() => r.board.refundForNonDelivery(agreed.id, '二重'), /既に閉じている/);
});

test('二重 release / 二重 refund をしない', () => {
  const r = rig();
  const agreed = openAndAgree(r);
  r.board.fund(agreed.id);
  r.board.completeLeg(agreed.id, 0, 'done');
  r.board.settle(agreed.id, { paymentValid: true });
  assert.throws(() => r.board.settle(agreed.id, { paymentValid: true }), /納品前に精算しない/);
  assert.throws(() => r.board.escrow.release(agreed.id, { paymentValid: true }), /held でない/);
  assert.throws(() => r.board.escrow.refund(agreed.id, 'x'), /held でない/);
});

test('arbitration: release と refund の両方で決着し、勝敗が standing に出る', () => {
  const forRelease = rig();
  const a = openAndAgree(forRelease);
  forRelease.board.fund(a.id);
  forRelease.board.completeLeg(a.id, 0, 'done');
  forRelease.board.openDispute(a.id, forRelease.principalId, '品が違う');
  const agentBefore = forRelease.identity.standing(forRelease.agentId).score;
  const resolvedRelease = forRelease.board.resolveDispute({
    disputeId: `dispute-${a.id}`,
    arbiterId: forRelease.arbiterId,
    outcome: 'release',
    resolution: '納品は妥当',
    paymentValid: true,
  });
  assert.equal(resolvedRelease.commission.state, 'settled');
  assert.equal(forRelease.board.escrow.get(a.id)?.state, 'released');
  assert.ok(forRelease.identity.standing(forRelease.agentId).score > agentBefore);

  const forRefund = rig();
  const b = openAndAgree(forRefund);
  forRefund.board.fund(b.id);
  forRefund.board.openDispute(b.id, forRefund.principalId, '届かない');
  const resolvedRefund = forRefund.board.resolveDispute({
    disputeId: `dispute-${b.id}`,
    arbiterId: forRefund.arbiterId,
    outcome: 'refund',
    resolution: '不履行',
  });
  assert.equal(resolvedRefund.commission.state, 'refunded');
  assert.equal(forRefund.board.escrow.get(b.id)?.state, 'refunded');
  assert.equal(forRefund.identity.reputationOf(forRefund.agentId).at(-1)?.kind, 'dispute_lost');
});

test('当事者は arbiter になれない。解決済みの係争は再解決しない', () => {
  const r = rig();
  const a = openAndAgree(r);
  r.board.fund(a.id);
  r.board.openDispute(a.id, r.principalId, 'x');
  assert.throws(
    () =>
      r.board.resolveDispute({ disputeId: `dispute-${a.id}`, arbiterId: r.principalId, outcome: 'refund', resolution: 'x' }),
    /当事者は arbiter になれない/,
  );
  r.board.resolveDispute({ disputeId: `dispute-${a.id}`, arbiterId: r.arbiterId, outcome: 'refund', resolution: 'x' });
  assert.throws(
    () =>
      r.board.resolveDispute({ disputeId: `dispute-${a.id}`, arbiterId: r.arbiterId, outcome: 'refund', resolution: 'y' }),
    /既に解決済み/,
  );
});

test('config に無い品目・交易相手は受け付けない', () => {
  const r = rig();
  assert.throws(
    () =>
      r.board.open({ principalId: r.principalId, itemId: 'no-such-item', quantity: 1, amount: '1', legs: [{ partnerId: r.partnerId }] }),
    (error: unknown) => {
      assert.ok(error instanceof CommissionError);
      return true;
    },
  );
  assert.throws(
    () =>
      r.board.open({ principalId: r.principalId, itemId: r.itemId, quantity: 1, amount: '1', legs: [{ partnerId: 'atlantis' }] }),
    /config に無い交易相手/,
  );
});

test('精算の記録にアドレスも金額も残らない（M5 の線を守る）', () => {
  const r = rig();
  const agreed = openAndAgree(r);
  r.board.fund(agreed.id);
  r.board.completeLeg(agreed.id, 0, 'done');
  r.board.settle(agreed.id, { paymentValid: true });
  const paymentEvents = r.log.readAll().filter((e) => e.type === 'payment_verified');
  assert.equal(paymentEvents.length, 1);
  assert.equal(findAddresses(paymentEvents).length, 0);
  assert.equal(JSON.stringify(paymentEvents).includes('10000'), false);
});

test('物販は副モジュール。市場は M1 が正で、commission board を参照しない', () => {
  const log = new MemoryEventLog();
  const sim = new MarketSimulation({ config: world, seed: seedFrom('storefront') });
  sim.stepMany(30);
  const storefront = new GoodsStorefront({ world, sim, log });

  assert.equal(storefront.rank, 'secondary');
  assert.equal(storefront.subordinateTo, 'commission-board');
  const listing = storefront.listing();
  assert.deepEqual(
    listing.map((l) => l.itemId),
    sim.items.map((i) => i.id),
  );

  const receipt = storefront.buy({ buyerId: 'id-0001', itemId: listing[0]!.itemId, quantity: 1 });
  assert.equal(receipt.provisional, true, '精算単位が未確定なので仮の金額');
  assert.equal(receipt.unitPriceAtPurchase, listing[0]!.state.price);
  assert.throws(() => storefront.buy({ buyerId: 'id-0001', itemId: 'nope', quantity: 1 }), StorefrontError);
  assert.throws(
    () => storefront.buy({ buyerId: 'id-0001', itemId: listing[0]!.itemId, quantity: 10_000_000 }),
    /在庫不足/,
  );

  // 副モジュールが主モジュールを参照していないことを構造としても固定する。
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/commission/storefront.ts'),
    'utf8',
  );
  assert.ok(!source.includes("from './board.js'"), '物販から commission board を参照しない');
  assert.ok(!source.includes('CommissionBoard'));
});

test('escrow: 二重 fund をしない。0 や非整数の金額は積まない', () => {
  const r = rig();
  const agreed = openAndAgree(r);
  r.board.fund(agreed.id);
  assert.throws(() => r.board.fund(agreed.id), /締結前に escrow は積まない|既に held/);
  assert.throws(() => r.board.escrow.fund('x-0', '0'), /0 の escrow は積まない/);
  assert.throws(() => r.board.escrow.fund('x-1', '10.5'), /最小単位の整数文字列/);
});

test('係争の解決で release するには payment_valid が要る', () => {
  const r = rig();
  const a = openAndAgree(r);
  r.board.fund(a.id);
  r.board.completeLeg(a.id, 0, 'done');
  r.board.openDispute(a.id, r.principalId, '確認したい');
  assert.throws(
    () =>
      r.board.resolveDispute({
        disputeId: `dispute-${a.id}`,
        arbiterId: r.arbiterId,
        outcome: 'release',
        resolution: '妥当',
      }),
    /payment_valid が無いまま release しない/,
  );
  assert.equal(r.board.escrow.get(a.id)?.state, 'held', '失敗しても escrow は開かない');
});

test('release と refund は競合しない（先に閉じた側が勝ち、もう片方は落ちる）', () => {
  const settledFirst = rig();
  const a = openAndAgree(settledFirst);
  settledFirst.board.fund(a.id);
  settledFirst.board.completeLeg(a.id, 0, 'done');
  settledFirst.board.settle(a.id, { paymentValid: true });
  assert.throws(() => settledFirst.board.refundForNonDelivery(a.id, '後から払い戻し'), /既に閉じている/);

  const refundedFirst = rig();
  const b = openAndAgree(refundedFirst);
  refundedFirst.board.fund(b.id);
  refundedFirst.board.completeLeg(b.id, 0, 'done');
  refundedFirst.board.refundForNonDelivery(b.id, '先に払い戻し');
  assert.throws(() => refundedFirst.board.settle(b.id, { paymentValid: true }), /納品前に精算しない/);
});

test('解決済みの係争のあとに払い戻しを重ねられない', () => {
  const r = rig();
  const a = openAndAgree(r);
  r.board.fund(a.id);
  r.board.openDispute(a.id, r.principalId, '届かない');
  r.board.resolveDispute({ disputeId: `dispute-${a.id}`, arbiterId: r.arbiterId, outcome: 'refund', resolution: '不履行' });
  assert.throws(() => r.board.refundForNonDelivery(a.id, '二重'), /既に閉じている/);
  assert.equal(r.board.escrow.get(a.id)?.state, 'refunded');
});

test('arbiter の権限境界: 未知の identity は arbiter になれない', () => {
  const r = rig();
  const a = openAndAgree(r);
  r.board.fund(a.id);
  r.board.openDispute(a.id, r.agentId, '報酬が出ない');
  assert.throws(
    () =>
      r.board.resolveDispute({ disputeId: `dispute-${a.id}`, arbiterId: 'id-9999', outcome: 'refund', resolution: 'x' }),
    /未知の identity/,
  );
  assert.throws(
    () =>
      r.board.resolveDispute({ disputeId: `dispute-${a.id}`, arbiterId: r.agentId, outcome: 'refund', resolution: 'x' }),
    /当事者は arbiter になれない/,
  );
});

test('arbiter を要らない設定なら当事者チェックも走らない（設定は仮値）', () => {
  const log = new MemoryEventLog();
  const identity = new IdentityService({ identityConfig, roomsConfig, seed: 5 });
  const principalId = identity.createIdentity({ kind: 'human' }).id;
  const agentId = identity.createIdentity({ kind: 'agent', principalId }).id;
  const board = new CommissionBoard({
    config: { ...commissionConfig, arbitration: { ...commissionConfig.arbitration, requiresArbiter: false } },
    world,
    identity,
    log,
  });
  const commission = board.open({
    principalId,
    itemId: world.stall_categories.imports[0]!.id,
    quantity: 1,
    amount: '10000',
    legs: [{ partnerId: world.trade_partners[0]!.id }],
  });
  board.proposeAgent(commission.id, agentId);
  board.agree(commission.id, principalId);
  board.agree(commission.id, agentId);
  board.fund(commission.id);
  board.openDispute(commission.id, principalId, 'x');
  const resolved = board.resolveDispute({
    disputeId: `dispute-${commission.id}`,
    arbiterId: 'not-an-identity',
    outcome: 'refund',
    resolution: '設定次第',
  });
  assert.equal(resolved.commission.state, 'refunded');
  assert.equal(commissionConfig.arbitration.confirmed, false, 'arbitration の方針は未確定');
});

test('当事者でない者は係争を起こせない。未定義の結果は受け付けない', () => {
  const r = rig();
  const a = openAndAgree(r);
  r.board.fund(a.id);
  assert.throws(() => r.board.openDispute(a.id, r.arbiterId, 'x'), /当事者でない/);
  r.board.openDispute(a.id, r.principalId, 'x');
  assert.throws(
    () =>
      r.board.resolveDispute({
        disputeId: `dispute-${a.id}`,
        arbiterId: r.arbiterId,
        outcome: 'split' as never,
        resolution: 'x',
      }),
    /未定義の結果/,
  );
});

test('レグが失敗したままでは精算しない', () => {
  const r = rig();
  const commission = r.board.open({
    principalId: r.principalId,
    itemId: r.itemId,
    quantity: 1,
    amount: '10000',
    legs: [{ partnerId: world.trade_partners[0]!.id }, { partnerId: world.trade_partners[1]!.id }],
  });
  r.board.proposeAgent(commission.id, r.agentId);
  r.board.agree(commission.id, r.principalId);
  r.board.agree(commission.id, r.agentId);
  r.board.fund(commission.id);
  r.board.completeLeg(commission.id, 0, 'done');
  const partial = r.board.completeLeg(commission.id, 1, 'failed');
  assert.equal(partial.state, 'in_progress');
  assert.throws(() => r.board.settle(commission.id, { paymentValid: true }), /納品前に精算しない/);
  assert.throws(() => r.board.completeLeg(commission.id, 1, 'done'), /既に failed のレグ/);
});

test('委託の入力を推測で埋めない（数量・レグの重複）', () => {
  const r = rig();
  const base = { principalId: r.principalId, itemId: r.itemId, amount: '10000' };
  assert.throws(() => r.board.open({ ...base, quantity: 0, legs: [{ partnerId: r.partnerId }] }), /数量は 1 以上/);
  assert.throws(() => r.board.open({ ...base, quantity: 1.5, legs: [{ partnerId: r.partnerId }] }), /数量は 1 以上/);
  assert.throws(
    () => r.board.open({ ...base, quantity: 1, legs: [{ partnerId: r.partnerId }, { partnerId: r.partnerId }] }),
    /レグが重複/,
  );
});
