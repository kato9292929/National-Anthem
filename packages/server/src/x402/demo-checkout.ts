import type { PaymentLeg, PaymentPayload, X402Config } from '@na/shared';
import type { PrivateGateway } from '../privacy/gateway.js';
import { buildRequirements, FeePayerResolver, verifyThenSettle } from './challenge.js';
import { FacilitatorClient } from './facilitator.js';
import { startMockFacilitator, type MockFacilitator } from './mock/facilitator.js';
import type { PaymentSigner } from './signer.js';

/**
 * 物販デモ（区分A・mock）の x402 一周を、段階ごとの実イベントとして流す。
 *
 * 画面の主役はこの決済フロー。各ステップは演出ではなく、実際の処理の結果に紐づく:
 *   402（価格提示）→ 署名送信（mock 署名）→ payment_valid（Gateway 検証）→ 清算（mock 着金）
 *
 * すべて mock。実チェーンには何も出さない。tx は mock: 前置き、onChain は false。
 * - feePayer は毎回 mock facilitator の /supported から取る（config に持たない・ハードコードしない）。
 * - 検証は privacy Gateway（mock MXE）経由。返るのは payment_valid だけ。
 * - settle は FacilitatorClient 経由で mock facilitator（ループバック）に出す。
 * - verify か settle が落ちたら settled を出さない。失敗を失敗として流す（成功に見せない）。
 */

export type CheckoutStepName = 'challenge' | 'signed' | 'verified' | 'settled' | 'failed';

export interface CheckoutStep {
  step: CheckoutStepName;
  ok: boolean;
  at: number;
  /** 画面に出す最小限。mock: を残す。 */
  detail: Record<string, unknown>;
}

export interface CheckoutResult {
  ok: boolean;
  buyerKind: 'human' | 'agent';
  railId: string;
  amount: string;
  feePayer: string | null;
  steps: CheckoutStep[];
  settlement: Record<string, unknown> | null;
  failure: { stage: string; reason: string } | null;
}

export interface CheckoutInput {
  resource: string;
  description: string;
  amount: string;
  buyerKind: 'human' | 'agent';
  /**
   * 異常系を画面で見せるための強制失敗（スモーク専用）。
   * 決して成功として扱わない。verify / settle のどちらを落とすか。
   */
  simulateFailure?: 'verify' | 'settle';
}

export interface DemoCheckoutOptions {
  config: X402Config;
  railId: string;
  signers: PaymentSigner[];
  gateway: PrivateGateway;
  now?: () => number;
}

export class DemoCheckout {
  private facilitator: MockFacilitator | null = null;
  private client: FacilitatorClient | null = null;
  private feePayerResolver: FeePayerResolver | null = null;
  private readonly now: () => number;

  constructor(private readonly options: DemoCheckoutOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** mock facilitator はループバックで一度だけ立てる（区分A・実網に出ない）。 */
  private async ensure(): Promise<{ client: FacilitatorClient; feePayer: FeePayerResolver }> {
    if (!this.facilitator || !this.client || !this.feePayerResolver) {
      this.facilitator = await startMockFacilitator();
      this.client = new FacilitatorClient(this.facilitator.url);
      this.feePayerResolver = new FeePayerResolver(this.options.config, this.client, this.now);
    }
    return { client: this.client, feePayer: this.feePayerResolver };
  }

  async close(): Promise<void> {
    await this.facilitator?.close();
    this.facilitator = null;
    this.client = null;
    this.feePayerResolver = null;
  }

  async run(input: CheckoutInput, onStep?: (step: CheckoutStep) => void): Promise<CheckoutResult> {
    const { config, railId } = this.options;
    const rail = config.rails.find((r) => r.id === railId);
    if (!rail) throw new Error(`config に無い rail: ${railId}`);
    if (!rail.confirmed) throw new Error(`未確定の rail では決済できない: ${railId}`);

    const signer = this.options.signers.find((s) => s.railIds.includes(railId));
    if (!signer || signer.id.startsWith('unavailable:')) {
      // mock 署名口が無ければ落とす（偽の署名を作らない）。区分A は NA_X402_MOCK=1 が要る。
      throw new Error(`rail ${railId} の mock 署名口が無い。区分A の決済デモは NA_X402_MOCK=1 で動く`);
    }

    const { client, feePayer: feePayerResolver } = await this.ensure();
    const steps: CheckoutStep[] = [];
    const emit = (step: CheckoutStep): void => {
      steps.push(step);
      onStep?.(step);
    };

    // 1. 402（価格提示）。feePayer は毎回 /supported から取り直す。
    const feePayer = await feePayerResolver.resolve();
    const requirements = buildRequirements({
      config,
      railId,
      resource: input.resource,
      description: input.description,
      amount: input.amount,
      feePayer,
    });
    emit({
      step: 'challenge',
      ok: true,
      at: this.now(),
      detail: {
        amount: input.amount,
        asset: rail.asset,
        network: rail.network,
        feePayer,
        legs: requirements.accepts.length,
        mock: true,
      },
    });

    // 2. 署名送信（mock 署名）。払う leg は v2。feePayer は 402 の値をそのまま載せる。
    const leg: PaymentLeg = {
      scheme: config.protocol.scheme,
      network: rail.network,
      asset: rail.asset,
      amount: input.amount,
      legVersion: 2,
      payTo: rail.payTo,
      resource: input.resource,
      description: input.description,
      ...(feePayer ? { extra: { resource: input.resource, feePayer } } : {}),
    };
    const signed = await signer.sign({ leg, rail, feePayer, resourceUrl: input.resource });
    const payload: PaymentPayload = {
      x402Version: config.protocol.x402Version,
      scheme: leg.scheme,
      network: leg.network,
      payload: signed,
    };
    emit({
      step: 'signed',
      ok: true,
      at: this.now(),
      detail: {
        railId: rail.id,
        payer: String(signed['payer'] ?? 'mock:payer'),
        signature: String(signed['signature'] ?? ''),
        feePayer,
        mock: true,
      },
    });

    // 3 + 4. payment_valid → 清算。どちらか落ちたら清算しない・成功に見せない。
    const outcome = await verifyThenSettle({
      payload: payload as unknown as Record<string, unknown>,
      leg: leg as unknown as Record<string, unknown>,
      verify: async (p, l) => {
        if (input.simulateFailure === 'verify') {
          emit({ step: 'verified', ok: false, at: this.now(), detail: { payment_valid: false, forced: true } });
          return { isValid: false, invalidReason: 'demo_forced_invalid' };
        }
        // 検証は MXE の中で走り、返るのは payment_valid のみ。
        const verification = await this.options.gateway.verify({ payload: p, leg: l });
        emit({
          step: 'verified',
          ok: verification.payment_valid,
          at: this.now(),
          detail: { payment_valid: verification.payment_valid },
        });
        return {
          isValid: verification.payment_valid,
          invalidReason: verification.payment_valid ? null : 'payment_invalid',
        };
      },
      settle: async (p, l) => {
        if (input.simulateFailure === 'settle') {
          return { success: false, errorReason: 'demo_forced_settle_fail' };
        }
        return { ...(await client.settle(p, l)) };
      },
    });

    if (!outcome.ok) {
      const stage = String(outcome.response['stage'] ?? 'unknown');
      const reason = String(outcome.response['errorReason'] ?? 'unknown');
      emit({ step: 'failed', ok: false, at: this.now(), detail: { stage, reason, mock: true } });
      return {
        ok: false,
        buyerKind: input.buyerKind,
        railId: rail.id,
        amount: input.amount,
        feePayer,
        steps,
        settlement: null,
        failure: { stage, reason },
      };
    }

    // 清算（mock 着金）。tx は mock:／mock-tx-*、onChain は false。
    emit({
      step: 'settled',
      ok: true,
      at: this.now(),
      detail: {
        transaction: String(outcome.response['transaction'] ?? ''),
        payer: String(outcome.response['payer'] ?? ''),
        network: String(outcome.response['network'] ?? ''),
        onChain: false,
        mock: true,
      },
    });
    return {
      ok: true,
      buyerKind: input.buyerKind,
      railId: rail.id,
      amount: input.amount,
      feePayer,
      steps,
      settlement: outcome.response,
      failure: null,
    };
  }
}
