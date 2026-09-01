import { arr, obj, oneOf, str } from './guards.js';
import type { IdentityConfig } from './identity.config.types.js';
import type { PrivacyConfig } from './privacy.types.js';
import type { X402Config } from './x402.types.js';

/**
 * 区分B（実キー・実ネットワークが要る確認）の証拠。
 *
 * verified:true は「実確認が通った」ことだけを意味する。実装が終わったから上げる、はしない。
 * そのために、verified:true の項目には必ず対応する証拠レコードを要求する。
 * 証拠が無いのに true になっている config は読み込み時に落ちる。
 */

export const EVIDENCE_KINDS = [
  'settlement',
  'signature',
  'mxe-verification',
  'identity-lookup',
  'wallet-issuance',
  'facilitator-reachability',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface VerificationRecord {
  /** 何の verified を裏付けるか。例: x402.rails.solana / identity.erc8004.base */
  target: string;
  kind: EvidenceKind;
  /** ISO8601。 */
  at: string;
  /** CAIP-2 など。該当しなければ空文字ではなく省略する。 */
  network?: string;
  /** 実 tx ハッシュ・レコード id・照会結果など。空は許さない。 */
  evidence: Record<string, string>;
  /** 誰／何が観測したか。 */
  observedBy: string;
  note: string;
}

export interface VerificationEvidence {
  version: string;
  records: VerificationRecord[];
}

export function validateVerificationEvidence(input: unknown, source: string): VerificationEvidence {
  const root = obj(input, source, '(root)');
  const records = arr(root['records'], source, 'records').map((v, i) => {
    const o = obj(v, source, `records[${i}]`);
    const evidence = obj(o['evidence'], source, `records[${i}].evidence`);
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(evidence)) {
      if (key.startsWith('$')) continue;
      entries[key] = str(value, source, `records[${i}].evidence.${key}`);
    }
    if (Object.keys(entries).length === 0) {
      throw new Error(`${source}: records[${i}].evidence が空。証拠の無いレコードは置かない`);
    }
    const network = o['network'];
    const record: VerificationRecord = {
      target: str(o['target'], source, `records[${i}].target`),
      kind: oneOf(o['kind'], EVIDENCE_KINDS, source, `records[${i}].kind`),
      at: str(o['at'], source, `records[${i}].at`),
      evidence: entries,
      observedBy: str(o['observedBy'], source, `records[${i}].observedBy`),
      note: str(o['note'], source, `records[${i}].note`),
    };
    if (network !== undefined) record.network = str(network, source, `records[${i}].network`);
    return record;
  });
  return { version: str(root['version'], source, 'version'), records };
}

export interface VerifiedFlag {
  target: string;
  verified: boolean;
  label: string;
}

/** config 側の verified フラグを、証拠と突き合わせられる形に並べる。 */
export function collectVerifiedFlags(input: {
  identity: IdentityConfig;
  x402: X402Config;
  privacy: PrivacyConfig;
}): VerifiedFlag[] {
  const flags: VerifiedFlag[] = [];
  for (const asset of input.identity.external_assets.erc8004) {
    flags.push({ target: `identity.erc8004.${asset.id}`, verified: asset.verified, label: `ERC-8004 ${asset.chain}#${asset.agentId}` });
  }
  for (const asset of input.identity.external_assets.signers) {
    flags.push({ target: `identity.signers.${asset.id}`, verified: asset.verified, label: `署名鍵 ${asset.id}` });
  }
  for (const asset of input.identity.external_assets.custodial_wallets) {
    flags.push({
      target: `identity.custodial_wallets.${asset.id}`,
      verified: asset.verified,
      label: `custodial wallet ${asset.id}`,
    });
  }
  flags.push({ target: 'x402.facilitator', verified: input.x402.facilitator.verified, label: `facilitator ${input.x402.facilitator.provider}` });
  for (const rail of input.x402.rails) {
    flags.push({ target: `x402.rails.${rail.id}`, verified: rail.verified, label: `rail ${rail.id}` });
  }
  flags.push({ target: 'privacy.gateway', verified: input.privacy.gateway.verified, label: 'Arcium MXE / Gateway' });
  return flags;
}

export class UnbackedVerificationError extends Error {
  override readonly name = 'UnbackedVerificationError';
  constructor(readonly targets: string[]) {
    super(
      '証拠の無い verified:true がある（実確認が通っていないものを確認済みにしない）: ' + targets.join(', '),
    );
  }
}

/** verified:true に証拠が付いているかを突き合わせる。付いていなければ落とす。 */
export function assertVerifiedHasEvidence(input: {
  flags: VerifiedFlag[];
  evidence: VerificationEvidence;
}): void {
  const covered = new Set(input.evidence.records.map((r) => r.target));
  const unbacked = input.flags.filter((f) => f.verified && !covered.has(f.target)).map((f) => f.target);
  if (unbacked.length > 0) throw new UnbackedVerificationError(unbacked);
}

/** 進捗の要約。README と起動ログに出す。 */
export function verificationSummary(input: {
  flags: VerifiedFlag[];
  evidence: VerificationEvidence;
}): { total: number; verified: number; pending: string[] } {
  const pending = input.flags.filter((f) => !f.verified).map((f) => f.target);
  return { total: input.flags.length, verified: input.flags.length - pending.length, pending };
}
