import type { ChainKind, PaymentLeg, RailConfig } from '@na/shared';

/**
 * 支払いの署名口。
 * 実鍵での署名（Solana keypair / EVM EIP-712）は区分B（加藤さん環境）。
 * ここでは interface と、鍵が無いときに黙って通さない実装だけを置く。
 */

export interface PaymentIntent {
  leg: PaymentLeg;
  rail: RailConfig;
  /** 402 の extra.feePayer から毎回取った値。config 由来ではない。 */
  feePayer: string | null;
  resourceUrl: string;
}

export interface PaymentSigner {
  id: string;
  chainKind: ChainKind;
  /** 署名できる rail の id。ここに無い rail では絶対に署名しない（bridge しない）。 */
  railIds: string[];
  sign(intent: PaymentIntent): Promise<Record<string, unknown>>;
}

/**
 * 鍵が無いレールの署名口。呼ばれたら落ちる。
 * 「払えないので別レールで払う」を防ぐため、フォールバックを持たせない。
 */
export function unavailableSigner(rail: RailConfig, reason: string): PaymentSigner {
  return {
    id: `unavailable:${rail.id}`,
    chainKind: rail.chainKind,
    railIds: [rail.id],
    sign() {
      return Promise.reject(
        new Error(
          `rail ${rail.id} の署名鍵が無い（未検証・区分B）: ${reason}。` +
            '別レールへの振り替えはしない（bridge しない）',
        ),
      );
    },
  };
}

/** 区分A の一周確認に使う mock。実チェーンには何も出さない。 */
export class MockPaymentSigner implements PaymentSigner {
  readonly id: string;
  constructor(
    readonly chainKind: ChainKind,
    readonly railIds: string[],
    private readonly address = 'mock:payer',
  ) {
    this.id = `mock:${railIds.join(',')}`;
  }

  sign(intent: PaymentIntent): Promise<Record<string, unknown>> {
    if (!this.railIds.includes(intent.rail.id)) {
      return Promise.reject(new Error(`この signer は rail ${intent.rail.id} を扱わない`));
    }
    return Promise.resolve({
      mock: true,
      payer: this.address,
      amount: intent.leg.amount,
      asset: intent.leg.asset,
      network: intent.leg.network,
      payTo: intent.leg.payTo,
      // feePayer は 402 から来た値をそのまま載せる。ここで既定値に置き換えない。
      feePayer: intent.feePayer,
      signature: `mock-signature:${intent.rail.id}:${intent.leg.amount}:${intent.feePayer ?? 'none'}`,
    });
  }
}
