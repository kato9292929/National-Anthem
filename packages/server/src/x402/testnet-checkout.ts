import type { PaymentLeg, X402Config } from '@na/shared';
import { parseRequirements, parseSettlement, readFeePayer } from './client.js';
import { createPayingFetch, type SdkPayerEnv } from './sdk-payer.js';
import type { Checkout, CheckoutInput, CheckoutResult, CheckoutStep } from './demo-checkout.js';

/**
 * 実 testnet（Base Sepolia）の決済一周。区分B（実 facilitator・実 EVM 鍵・実ネットワーク）。
 *
 * mock ではなく実チェーンに tx を出す。4 段（画面はそのまま）:
 *   402 受信 → 署名（実 EIP-712 TransferWithAuthorization・公式 SDK）→ payment_valid → 清算（実 tx）
 *
 * 仕組み:
 *  - 払う先の資源は National Anthem 自身の paywall エンドポイント（NA_X402_PAYWALL=1）。
 *  - 署名は公式 SDK（@x402/fetch + @x402/evm）に委ねる。payload も EIP-712 domain も自前で組まない・推測しない。
 *  - 検証・清算は実 facilitator（NA_X402_FACILITATOR_URL）。返る PAYMENT-RESPONSE から実 tx を取る。
 *  - tx は mock: を付けない（実物）。network は Base Sepolia。onChain:true。
 *  - どの段で落ちても握りつぶさず失敗として流す（偽 tx・偽着金を作らない）。
 */

export interface TestnetCheckoutOptions {
  config: X402Config;
  railId: string;
  /** 実支払いの鍵など（SdkPayerEnv）。 */
  sdkEnv: SdkPayerEnv;
  /** 払う先（自分の paywall 資源）の絶対 URL。 */
  resourceUrl: string;
  now?: () => number;
}

export class TestnetCheckout implements Checkout {
  readonly mode = 'testnet' as const;
  private readonly now: () => number;

  constructor(private readonly options: TestnetCheckoutOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async close(): Promise<void> {
    /* 実 facilitator はループバックのサーバを持たない。閉じるものは無い。 */
  }

  async run(input: CheckoutInput, onStep?: (step: CheckoutStep) => void): Promise<CheckoutResult> {
    const { config, railId } = this.options;
    const rail = config.rails.find((r) => r.id === railId);
    if (!rail) throw new Error(`config に無い rail: ${railId}`);
    if (!rail.confirmed) {
      // 未確定のレールで 402 を出さない（payTo 未設定など）。偽の決済を作らない。
      throw new Error(`rail ${railId} が未確定（payTo など）。config を確定してから testnet 決済を回す`);
    }
    if (rail.chainKind !== 'evm') {
      throw new Error(`testnet 決済は EVM レール向け（rail ${railId} は ${rail.chainKind}）`);
    }

    const steps: CheckoutStep[] = [];
    const emit = (step: CheckoutStep): void => {
      steps.push(step);
      onStep?.(step);
    };
    const fail = (stage: string, reason: string): CheckoutResult => {
      emit({ step: 'failed', ok: false, at: this.now(), detail: { stage, reason, testnet: true } });
      return {
        ok: false,
        buyerKind: input.buyerKind,
        railId: rail.id,
        amount: input.amount,
        feePayer: null,
        steps,
        settlement: null,
        failure: { stage, reason },
      };
    };

    // 1. 402（価格提示）。素の fetch で自分の paywall 資源を叩き、要求を読む。
    let probe: Response;
    try {
      probe = await fetch(this.options.resourceUrl, { headers: { accept: 'application/json' } });
    } catch (error) {
      return fail('challenge', `資源に到達できない: ${message(error)}`);
    }
    if (probe.status !== 402) {
      return fail('challenge', `402 が返らない（status ${probe.status}）。paywall が有効か確認する`);
    }
    let leg: PaymentLeg;
    let feePayer: string | null;
    try {
      const requirements = parseRequirements(probe, config);
      // 払うのは自分のレールの leg（v2）。network 完全一致で選ぶ。
      const found = requirements.accepts.find((l) => l.network === rail.network && l.legVersion === 2);
      if (!found) throw new Error(`accepts に ${rail.network} の v2 leg が無い`);
      leg = found;
      feePayer = readFeePayer(leg);
    } catch (error) {
      return fail('challenge', `402 を読めない: ${message(error)}`);
    }
    emit({
      step: 'challenge',
      ok: true,
      at: this.now(),
      detail: {
        amount: leg.amount,
        asset: rail.asset,
        network: rail.network,
        payTo: rail.payTo,
        feePayer,
        testnet: true,
      },
    });

    // 2. 署名送信（実 EIP-712・公式 SDK）。payload も domain も SDK が組む。
    let payingFetch: typeof fetch;
    try {
      payingFetch = await createPayingFetch(config, this.options.sdkEnv);
    } catch (error) {
      // 鍵が無い等はここで落ちる（偽署名は作らない）。
      return fail('signed', `実署名の口を作れない: ${message(error)}`);
    }
    emit({
      step: 'signed',
      ok: true,
      at: this.now(),
      detail: { railId: rail.id, network: rail.network, scheme: config.protocol.scheme, feePayer, testnet: true },
    });

    // 3 + 4. payment_valid → 清算（実 facilitator）。返る PAYMENT-RESPONSE から実 tx を取る。
    let paid: Response;
    try {
      paid = await payingFetch(this.options.resourceUrl, { headers: { accept: 'application/json' } });
    } catch (error) {
      return fail('settle', `支払い後の応答が無い: ${message(error)}`);
    }
    if (paid.status === 402) {
      return fail('verify', '再送しても 402（検証が通っていない）。偽の成功にしない');
    }
    if (!paid.ok) {
      return fail('settle', `支払い後に ${paid.status} が返った: ${(await safeText(paid)).slice(0, 200)}`);
    }
    let settlement: Record<string, unknown>;
    try {
      settlement = parseSettlement(paid, config) as unknown as Record<string, unknown>;
    } catch (error) {
      return fail('settle', `settle 結果を読めない: ${message(error)}`);
    }
    if (settlement['success'] !== true) {
      return fail('settle', `settle が成功しなかった: ${JSON.stringify(settlement).slice(0, 200)}`);
    }
    const transaction = String(settlement['transaction'] ?? '');
    if (transaction === '') {
      return fail('settle', 'settle 成功だが tx hash が無い（実 tx を確認できない）');
    }

    // 検証は settle 成功をもって通ったものとして流す（実 facilitator が verify→settle した）。
    emit({ step: 'verified', ok: true, at: this.now(), detail: { payment_valid: true, testnet: true } });
    emit({
      step: 'settled',
      ok: true,
      at: this.now(),
      detail: {
        transaction,
        network: String(settlement['network'] ?? rail.network),
        payer: String(settlement['payer'] ?? ''),
        onChain: true,
        testnet: true,
        ...(rail.explorer ? { explorer: `${rail.explorer}${transaction}` } : {}),
      },
    });

    return {
      ok: true,
      buyerKind: input.buyerKind,
      railId: rail.id,
      amount: input.amount,
      feePayer,
      steps,
      settlement,
      failure: null,
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(本文を読めない)';
  }
}
