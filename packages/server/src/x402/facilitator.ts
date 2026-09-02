import type { PaymentLeg, SettleResult, X402Config } from '@na/shared';

/**
 * facilitator への口。実 facilitator（PayAI）疎通は区分B。
 * 返り値の形が想定と違えば落とす（部分的に読めた分で先に進まない）。
 */

export interface VerifyResult {
  isValid: boolean;
  invalidReason: string | null;
}

export class FacilitatorClient {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** x402Version を wire に載せる（稼働プロダクトの @x402/core と同じ形）。 */
    private readonly x402Version = 2,
  ) {}

  /**
   * facilitator の /supported から現在の feePayer を取る。
   * PayAI はローテートするので固定しない。取れなければ null（accepts は空にしない）。
   */
  async supportedFeePayer(path = '/supported'): Promise<string | null> {
    const res = await this.fetchImpl(`${this.url}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`facilitator ${path} が ${res.status} を返した`);
    return extractFeePayer((await res.json()) as unknown);
  }

  async verify(payload: Record<string, unknown>, leg: PaymentLeg): Promise<VerifyResult> {
    const body = await this.post('/verify', this.wire(payload, leg));
    if (typeof body['isValid'] !== 'boolean') {
      throw new Error(`facilitator /verify の応答に isValid が無い: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return {
      isValid: body['isValid'],
      invalidReason: typeof body['invalidReason'] === 'string' ? body['invalidReason'] : null,
    };
  }

  async settle(payload: Record<string, unknown>, leg: PaymentLeg): Promise<SettleResult> {
    const body = await this.post('/settle', this.wire(payload, leg));
    if (typeof body['success'] !== 'boolean') {
      throw new Error(`facilitator /settle の応答に success が無い: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return body as unknown as SettleResult;
  }

  private wire(payload: Record<string, unknown>, leg: PaymentLeg): unknown {
    return {
      x402Version: (payload['x402Version'] as number | undefined) ?? this.x402Version,
      paymentPayload: payload,
      paymentRequirements: leg,
    };
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`facilitator ${path} が ${res.status} を返した`);
    }
    const parsed = (await res.json()) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`facilitator ${path} の応答がオブジェクトでない`);
    }
    return parsed as Record<string, unknown>;
  }
}

/** /supported の応答から最初の feePayer を拾う（形が変わっても壊れないように総なめする）。 */
export function extractFeePayer(payload: unknown): string | null {
  let found: string | null = null;
  const visit = (node: unknown): void => {
    if (found !== null || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (found !== null) return;
      if (key === 'feePayer' && typeof value === 'string' && value !== '') {
        found = value;
        return;
      }
      visit(value);
    }
  };
  visit(payload);
  return found;
}

/** config から使う値だけを渡すための薄い型（テストで config 全体を作らないため）。 */
export type FacilitatorPaths = Pick<X402Config['protocol'], 'supportedPath' | 'verifyPath' | 'settlePath'>;
