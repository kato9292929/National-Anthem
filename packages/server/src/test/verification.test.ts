import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertVerifiedHasEvidence,
  collectVerifiedFlags,
  UnbackedVerificationError,
  validateVerificationEvidence,
  verificationSummary,
} from '@na/shared';
import {
  loadIdentityConfig,
  loadPrivacyConfig,
  loadVerificationEvidence,
  loadX402Config,
} from '@na/shared/node';

const identity = loadIdentityConfig({}).value;
const x402 = loadX402Config({}).value;
const privacy = loadPrivacyConfig({}).value;
const evidence = loadVerificationEvidence({}).value;
const flags = collectVerifiedFlags({ identity, x402, privacy });

test('区分B は 1 件も実確認できていない（verified はすべて false）', () => {
  assert.ok(flags.length > 0);
  for (const flag of flags) {
    assert.equal(flag.verified, false, `${flag.target} が実確認なしで verified になっている`);
  }
  assert.equal(evidence.records.length, 0, '証拠レコードがあるのに verified が上がっていない、またはその逆');
  const summary = verificationSummary({ flags, evidence });
  assert.equal(summary.verified, 0);
  assert.equal(summary.pending.length, summary.total);
});

test('verified の対象は config のフラグと 1 対 1 で対応する', () => {
  const targets = flags.map((f) => f.target);
  assert.ok(targets.includes('x402.facilitator'));
  assert.ok(targets.includes('x402.rails.solana'));
  assert.ok(targets.includes('identity.erc8004.base'));
  assert.ok(targets.includes('identity.erc8004.arc-testnet'));
  assert.ok(targets.includes('identity.signers.aa-solana'));
  assert.ok(targets.includes('identity.custodial_wallets.dcw-evm-base'));
  assert.ok(targets.includes('identity.custodial_wallets.dcw-solana'));
  assert.ok(targets.includes('privacy.gateway'));
  assert.equal(new Set(targets).size, targets.length, 'target が重複している');
});

test('証拠の無い verified:true は落ちる（実装完了でフラグを上げられない）', () => {
  const lying = flags.map((f) => (f.target === 'x402.rails.solana' ? { ...f, verified: true } : f));
  assert.throws(() => assertVerifiedHasEvidence({ flags: lying, evidence }), (error: unknown) => {
    assert.ok(error instanceof UnbackedVerificationError);
    assert.deepEqual(error.targets, ['x402.rails.solana']);
    return true;
  });
});

test('証拠があれば verified:true を通す', () => {
  const withEvidence = {
    version: '0',
    records: [
      {
        target: 'x402.rails.solana',
        kind: 'settlement' as const,
        at: '2026-01-01T00:00:00Z',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        evidence: { txHash: 'example-tx-hash' },
        observedBy: 'test',
        note: 'テスト用',
      },
    ],
  };
  const lying = flags.map((f) => (f.target === 'x402.rails.solana' ? { ...f, verified: true } : f));
  assert.doesNotThrow(() => assertVerifiedHasEvidence({ flags: lying, evidence: withEvidence }));
});

test('中身の無い証拠レコードは受け付けない', () => {
  assert.throws(
    () =>
      validateVerificationEvidence(
        { version: '0', records: [{ target: 'x402.facilitator', kind: 'settlement', at: 'x', evidence: {}, observedBy: 'x', note: 'x' }] },
        'test',
      ),
    /evidence が空/,
  );
  assert.throws(
    () =>
      validateVerificationEvidence(
        { version: '0', records: [{ target: 'x', kind: 'no-such-kind', at: 'x', evidence: { a: 'b' }, observedBy: 'x', note: 'x' }] },
        'test',
      ),
    /records\[0\]\.kind/,
  );
});
