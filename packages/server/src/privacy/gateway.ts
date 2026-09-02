import type { PaymentLeg } from '@na/shared';
import { assertNoAddress } from './redact.js';

/**
 * x402 Private Gateway 経由の検証。
 * 検証は MXE（MPC クラスタ）の中で走り、返るのは payment_valid だけ。
 * 送金元・金額・エンドポイントは受け取らないし、記録もしない。
 *
 * これは「送金の追跡不能化」ではない。封印タブレット（case tablet）と同じで、
 * 条項を見せずに検証結果だけを返す形（world-spec §1）。ミキサーは実装しない。
 *
 * 実 MXE 投入・実 RPC は区分B（加藤さん環境）。
 */

export interface PrivacyConfigView {
  response: { allowedFields: string[] };
  recording: { walletAddressesAllowed: boolean };
  gateway: { url: string; confirmed: boolean; verified: boolean };
}

export interface GatewayVerification {
  payment_valid: boolean;
}

export interface MxeClient {
  id: string;
  /** MXE 内で検証し、bool だけを返す。 */
  verify(input: { payload: Record<string, unknown>; leg: PaymentLeg }): Promise<unknown>;
}

export class PrivacyError extends Error {
  override readonly name = 'PrivacyError';
}

export class PrivateGateway {
  constructor(
    private readonly mxe: MxeClient,
    private readonly config: PrivacyConfigView,
  ) {}

  /**
   * 返り値は payment_valid のみ。余計なフィールドが付いていたら受け取らずに落とす
   * （黙って捨てると、機密化できていないことに気づけない）。
   */
  async verify(input: { payload: Record<string, unknown>; leg: PaymentLeg }): Promise<GatewayVerification> {
    const raw = await this.mxe.verify(input);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new PrivacyError(`MXE の応答がオブジェクトでない: ${typeof raw}`);
    }
    const body = raw as Record<string, unknown>;
    const allowed = new Set(this.config.response.allowedFields);
    const extra = Object.keys(body).filter((key) => !allowed.has(key));
    if (extra.length > 0) {
      throw new PrivacyError(
        `MXE が許可外のフィールドを返した（機密化できていない）: ${extra.join(', ')}`,
      );
    }
    if (typeof body['payment_valid'] !== 'boolean') {
      throw new PrivacyError('MXE の応答に payment_valid（真偽値）が無い');
    }
    if (!this.config.recording.walletAddressesAllowed) {
      assertNoAddress(body, 'MXE の応答');
    }
    return { payment_valid: body['payment_valid'] };
  }
}

/**
 * Gateway への HTTP クライアント（記載仕様どおりの薄い口）。
 * 返る形の検査は PrivateGateway 側で行う。実 MXE 疎通は未検証（区分B）。
 */
export function createHttpMxeClient(url: string, fetchImpl: typeof fetch = fetch): MxeClient {
  return {
    id: `http-mxe:${url}`,
    async verify(input) {
      const res = await fetchImpl(`${url}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentPayload: input.payload, paymentRequirements: input.leg }),
      });
      if (!res.ok) {
        throw new PrivacyError(`Gateway /verify が ${res.status} を返した`);
      }
      try {
        return (await res.json()) as unknown;
      } catch (cause) {
        throw new PrivacyError(`Gateway /verify の応答を JSON として読めない: ${(cause as Error).message}`);
      }
    },
  };
}

/**
 * 検証を別の口（facilitator 等）に委ねる MXE。
 * 実 MXE が無い間も「常に true」ではなく、実際の検証結果を bool にして返す。
 * 外に出るのは payment_valid だけ、という契約はここでも保つ。
 */
export function createDelegatingMxe(
  id: string,
  verify: (input: { payload: Record<string, unknown>; leg: PaymentLeg }) => Promise<boolean>,
): MxeClient {
  return {
    id,
    verify: async (input) => ({ payment_valid: await verify(input) }),
  };
}

/** 区分A の結線確認用の stub。bool を返すだけで、入力は外に出さない。 */
export function createMockMxe(decide: (input: { leg: PaymentLeg }) => boolean = () => true): MxeClient {
  return {
    id: 'mock-mxe',
    verify: (input) => Promise.resolve({ payment_valid: decide({ leg: input.leg }) }),
  };
}
