import type { PaymentLeg, X402Config } from '@na/shared';
import { encodeHeader } from './client.js';
import type { FacilitatorClient } from './facilitator.js';

/**
 * 402 を出す側。National Anthem のエンドポイント自身を資源にする。
 *
 * 形は稼働プロダクト（X-alpha / OSD）の実装に合わせる:
 * - 要求は PAYMENT-REQUIRED ヘッダ（base64）、body は {}
 * - top-level は x402Version: 2
 * - accepts は v1 leg（network "solana" / maxAmountRequired）と
 *   v2 leg（CAIP-2 / amount）を併記する。現行クライアントが掴むのは v1 leg
 * - leg には resource / description / mimeType / maxTimeoutSeconds / extra.resource が要る
 * - feePayer だけが動的。facilitator の /supported から取り、取れなくても accepts は空にしない
 *
 * 出どころ: docs/x402-wire-contract.md
 */

export interface ChallengeInput {
  config: X402Config;
  railId: string;
  resource: string;
  description: string;
  amount?: string;
  feePayer: string | null;
}

export interface Requirements {
  x402Version: number;
  accepts: Record<string, unknown>[];
}

export function buildAccepts(input: ChallengeInput): Record<string, unknown>[] {
  const rail = input.config.rails.find((r) => r.id === input.railId);
  if (!rail) throw new Error(`config に無い rail: ${input.railId}`);
  if (!rail.confirmed) throw new Error(`未確定の rail では 402 を出せない: ${rail.id}`);
  if (rail.networkV1 === 'TBD') throw new Error(`rail ${rail.id} の v1 network が未確定`);

  const amount = input.amount ?? rail.defaultAmount;
  const base = (network: string): Record<string, unknown> => ({
    scheme: input.config.protocol.scheme,
    network,
    resource: input.resource,
    description: input.description,
    mimeType: input.config.protocol.mimeType,
    maxTimeoutSeconds: input.config.protocol.maxTimeoutSeconds,
    asset: rail.asset,
    payTo: rail.payTo,
    // feePayer が取れなくても leg は返す（accepts を空にしない）。
    extra: { resource: input.resource, ...(input.feePayer ? { feePayer: input.feePayer } : {}) },
  });

  return [
    { ...base(rail.networkV1), [input.config.protocol.legAmountFieldV1]: amount },
    { ...base(rail.network), [input.config.protocol.legAmountField]: amount },
  ];
}

export function buildRequirements(input: ChallengeInput): Requirements {
  return { x402Version: input.config.protocol.x402Version, accepts: buildAccepts(input) };
}

export function encodeRequirements(requirements: Requirements): string {
  return encodeHeader(requirements);
}

/**
 * feePayer は facilitator がローテートする。短く握って、取れなければ握らない。
 * 取れなかったことを成功に見せない（null を返す）。
 */
export class FeePayerResolver {
  private cached: { value: string; at: number } | null = null;

  constructor(
    private readonly config: X402Config,
    private readonly facilitator: FacilitatorClient | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async resolve(): Promise<string | null> {
    if (this.cached && this.now() - this.cached.at < this.config.feePayer.ttlMs) return this.cached.value;
    if (!this.facilitator) return null;
    try {
      const value = await this.facilitator.supportedFeePayer(this.config.protocol.supportedPath);
      if (value === null || value === '') return null;
      this.cached = { value, at: this.now() };
      return value;
    } catch {
      // 取れなかったときに古い値や既定値を使わない。402 は feePayer 無しで出す。
      return null;
    }
  }
}

/** クライアントが払った leg を、こちらが出した leg に突き合わせる。相手の主張は使わない。 */
export function matchRequirement(
  requirements: Requirements,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const accepted = payload['accepted'] as Record<string, unknown> | undefined;
  const scheme = (accepted?.['scheme'] ?? payload['scheme']) as string | undefined;
  const network = (accepted?.['network'] ?? payload['network']) as string | undefined;
  if (!scheme || !network) return null;
  return requirements.accepts.find((leg) => leg['scheme'] === scheme && leg['network'] === network) ?? null;
}

/** 402 応答の形（body は {}）。 */
export function paymentRequiredResponse(
  config: X402Config,
  requirements: Requirements,
  extraHeaders: Record<string, string> = {},
): { status: number; headers: Record<string, string>; body: string } {
  return {
    status: 402,
    headers: {
      'content-type': 'application/json',
      [config.protocol.requirementsHeader]: encodeRequirements(requirements),
      ...extraHeaders,
    },
    body: '{}',
  };
}

export function decodePaymentSignature(header: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export interface SettleOutcome {
  ok: boolean;
  response: Record<string, unknown>;
}

/**
 * verify → settle。どちらかが落ちたら 200 を返さない（passthrough しない）。
 * 例外は握って ok:false にするが、成功に見せることはしない。
 */
export async function verifyThenSettle(input: {
  payload: Record<string, unknown>;
  leg: Record<string, unknown>;
  verify: (payload: Record<string, unknown>, leg: PaymentLeg) => Promise<{ isValid: boolean; invalidReason: string | null }>;
  settle: (payload: Record<string, unknown>, leg: PaymentLeg) => Promise<Record<string, unknown>>;
}): Promise<SettleOutcome> {
  const leg = input.leg as unknown as PaymentLeg;
  let verification: { isValid: boolean; invalidReason: string | null };
  try {
    verification = await input.verify(input.payload, leg);
  } catch (error) {
    return { ok: false, response: { success: false, stage: 'verify', errorReason: 'verify_error', errorMessage: message(error) } };
  }
  if (!verification.isValid) {
    return {
      ok: false,
      response: { success: false, stage: 'verify', errorReason: verification.invalidReason ?? 'invalid_payment' },
    };
  }

  let settlement: Record<string, unknown>;
  try {
    settlement = await input.settle(input.payload, leg);
  } catch (error) {
    return { ok: false, response: { success: false, stage: 'settle', errorReason: 'settle_error', errorMessage: message(error) } };
  }
  if (settlement['success'] !== true) {
    return { ok: false, response: { success: false, stage: 'settle', ...settlement } };
  }
  return { ok: true, response: settlement };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
