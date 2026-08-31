import type { PaymentLeg, SettleResult } from '@na/shared';

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
  ) {}

  async verify(payload: Record<string, unknown>, leg: PaymentLeg): Promise<VerifyResult> {
    const body = await this.post('/verify', { paymentPayload: payload, paymentRequirements: leg });
    if (typeof body['isValid'] !== 'boolean') {
      throw new Error(`facilitator /verify の応答に isValid が無い: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return {
      isValid: body['isValid'],
      invalidReason: typeof body['invalidReason'] === 'string' ? body['invalidReason'] : null,
    };
  }

  async settle(payload: Record<string, unknown>, leg: PaymentLeg): Promise<SettleResult> {
    const body = await this.post('/settle', { paymentPayload: payload, paymentRequirements: leg });
    if (typeof body['success'] !== 'boolean') {
      throw new Error(`facilitator /settle の応答に success が無い: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return body as unknown as SettleResult;
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
