import type { X402Config } from '@na/shared';
import { MockPaymentSigner, unavailableSigner, type PaymentSigner } from './signer.js';

/**
 * 実行時にどのレールで払えるかを決める。
 * 実署名（Solana keypair / EVM EIP-712）は未実装・区分B。
 * 鍵が無いレールは「払えない」まま置く。別レールへ振り替えない。
 */

export interface X402Service {
  signers: PaymentSigner[];
  mode: 'mock' | 'unavailable';
  status(): unknown;
}

export function createX402Service(config: X402Config, env: NodeJS.ProcessEnv): X402Service {
  const useMock = env['NA_X402_MOCK'] === '1';
  const confirmedRails = config.rails.filter((r) => r.confirmed);

  const signers: PaymentSigner[] = confirmedRails.map((rail) =>
    useMock
      ? new MockPaymentSigner(rail.chainKind, [rail.id], `mock:payer:${rail.id}`)
      : unavailableSigner(rail, '実署名は未実装（区分B: 鍵とネットワークがある環境で消化する）'),
  );

  return {
    signers,
    mode: useMock ? 'mock' : 'unavailable',
    status: () => ({
      protocol: config.protocol,
      facilitator: config.facilitator,
      feePayer: {
        source: config.feePayer.source,
        note: 'feePayer は 402 の extra から毎回取る。config にもキャッシュにも置かない',
      },
      policy: config.policy,
      mode: useMock ? 'mock' : 'unavailable',
      rails: config.rails.map((rail) => ({
        id: rail.id,
        chainKind: rail.chainKind,
        network: rail.network,
        asset: rail.asset,
        payTo: rail.payTo,
        defaultAmount: rail.defaultAmount,
        decimals: rail.decimals,
        eip712Domain: rail.eip712Domain,
        confirmed: rail.confirmed,
        verified: rail.verified,
        canSign: signers.some((s) => s.railIds.includes(rail.id) && !s.id.startsWith('unavailable:')),
      })),
      notes: {
        signing: '実署名は未実装（区分B）。mock は NA_X402_MOCK=1 のときだけ',
        settlement: '実 facilitator / 実レール着金は未検証（区分B）',
        metric: 'per-call の件数を成長指標にしない。精算は M7 の commission の account 締めに紐付く',
      },
    }),
  };
}
