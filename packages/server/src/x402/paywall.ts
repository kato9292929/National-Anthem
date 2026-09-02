import type { PaymentLeg, X402Config } from '@na/shared';
import type { PrivateGateway } from '../privacy/gateway.js';
import {
  buildRequirements,
  decodePaymentSignature,
  matchRequirement,
  paymentRequiredResponse,
  verifyThenSettle,
  type FeePayerResolver,
} from './challenge.js';
import type { FacilitatorClient } from './facilitator.js';

/**
 * National Anthem 自身のエンドポイントを 402 でゲートする。
 * これが「払う先の資源」になる（外部に別のリソースを立てない）。
 *
 * 検証は privacy Gateway 経由（返るのは payment_valid だけ）。
 * settle は facilitator。どちらかが落ちたら 200 を返さない。
 */

export interface PaywallResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** ゲートの結果。paid のときは settle 結果のヘッダを 200 にも載せる。 */
export type PaywallResult =
  | { kind: 'disabled' }
  | { kind: 'challenge'; response: PaywallResponse }
  | { kind: 'paid'; headers: Record<string, string> };

export interface PaywallOptions {
  config: X402Config;
  railId: string;
  feePayer: FeePayerResolver;
  facilitator: FacilitatorClient | null;
  gateway: PrivateGateway;
  /** 実支払いの受け入れを有効にするか。既定は無効（区分A の一周は mock 側で行う）。 */
  enabled: boolean;
}

function encodeResponse(response: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(response), 'utf8').toString('base64');
}

export class Paywall {
  constructor(private readonly options: PaywallOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  /**
   * 支払い済みなら paid（settle 結果のヘッダ付き）。
   * 未払い・検証失敗なら challenge（402 応答）。
   */
  async guard(input: {
    paymentSignature: string | undefined;
    resource: string;
    description: string;
    amount?: string;
  }): Promise<PaywallResult> {
    if (!this.options.enabled) return { kind: 'disabled' };

    const feePayer = await this.options.feePayer.resolve();
    const requirements = buildRequirements({
      config: this.options.config,
      railId: this.options.railId,
      resource: input.resource,
      description: input.description,
      ...(input.amount === undefined ? {} : { amount: input.amount }),
      feePayer,
    });

    if (input.paymentSignature === undefined) {
      return { kind: 'challenge', response: paymentRequiredResponse(this.options.config, requirements) };
    }

    const payload = decodePaymentSignature(input.paymentSignature);
    if (!payload) {
      return this.fail(requirements, { success: false, stage: 'decode', errorReason: 'invalid_payment_signature_header' });
    }

    // 相手の主張ではなく、こちらが出した leg に突き合わせる。
    const leg = matchRequirement(requirements, payload);
    if (!leg) {
      return this.fail(requirements, { success: false, stage: 'match', errorReason: 'no_matching_payment_requirements' });
    }

    const facilitator = this.options.facilitator;
    if (!facilitator) {
      return this.fail(requirements, { success: false, stage: 'settle', errorReason: 'facilitator_not_configured' });
    }

    const outcome = await verifyThenSettle({
      payload,
      leg,
      // 検証は MXE の中で走り、返るのは payment_valid だけ。
      verify: async (verifyPayload, verifyLeg) => {
        const verification = await this.options.gateway.verify({ payload: verifyPayload, leg: verifyLeg });
        return { isValid: verification.payment_valid, invalidReason: verification.payment_valid ? null : 'payment_invalid' };
      },
      settle: async (settlePayload, settleLeg: PaymentLeg) => ({ ...(await facilitator.settle(settlePayload, settleLeg)) }),
    });

    if (!outcome.ok) return this.fail(requirements, outcome.response);
    // 成功しても settle 結果は返す（相手が tx を確認できるように）。
    return { kind: 'paid', headers: { [this.options.config.protocol.paymentResponseHeader]: encodeResponse(outcome.response) } };
  }

  /** 402 応答に settle 結果を載せる（成功・失敗どちらでも相手に返す）。 */
  private fail(requirements: ReturnType<typeof buildRequirements>, response: Record<string, unknown>): PaywallResult {
    return {
      kind: 'challenge',
      response: paymentRequiredResponse(this.options.config, requirements, {
        [this.options.config.protocol.paymentResponseHeader]: encodeResponse(response),
      }),
    };
  }
}
