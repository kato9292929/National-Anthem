import type { PaymentLeg, SettleResult } from '@na/shared';

/**
 * 区分B（実キー・実ネットワークが要る接続）の口。
 * ここで決めるのは interface と、鍵やエンドポイントが無いときの落ち方だけ。
 * 実接続は加藤さん環境で消化するまで verified:false のまま。
 * mock はもっともらしい偽レスポンスを作らない（値に mock: を必ず残す）。
 */

export type AdapterMode = 'mock' | 'live';

export interface AdapterStatus {
  id: string;
  kind: 'facilitator' | 'mxe' | 'erc8004' | 'custodial-wallet' | 'chain';
  mode: AdapterMode;
  /** 実接続の確認が済んでいるか。区分B が未消化の間は常に false。 */
  verified: boolean;
  /** live にするために要るもの（env 名など）。 */
  requires: string[];
  note: string;
}

export interface DescribedAdapter {
  status(): AdapterStatus;
}

export interface FacilitatorAdapter extends DescribedAdapter {
  verify(payload: Record<string, unknown>, leg: PaymentLeg): Promise<{ isValid: boolean; invalidReason: string | null }>;
  settle(payload: Record<string, unknown>, leg: PaymentLeg): Promise<SettleResult>;
}

export interface MxeVerification {
  payment_valid: boolean;
}

export interface MxeAdapter extends DescribedAdapter {
  verify(input: { payload: Record<string, unknown>; leg: PaymentLeg }): Promise<unknown>;
}

export interface Erc8004Record {
  chain: string;
  agentId: string;
  /** 実チェーンから引いた値かどうか。mock なら false。 */
  onChain: boolean;
  owner: string;
  registeredAt: number | null;
}

export interface Erc8004Adapter extends DescribedAdapter {
  lookupAgent(input: { chain: string; agentId: string }): Promise<Erc8004Record>;
}

export interface CustodialWalletRecord {
  id: string;
  chain: string;
  address: string;
  provider: string;
  onChain: boolean;
}

export interface CustodialWalletAdapter extends DescribedAdapter {
  getWallet(id: string): Promise<CustodialWalletRecord>;
}

export interface ChainBalance {
  address: string;
  asset: string;
  /** 最小単位の整数文字列。 */
  amount: string;
  onChain: boolean;
}

export interface ChainAdapter extends DescribedAdapter {
  getBalance(input: { address: string; asset: string }): Promise<ChainBalance>;
  getTransaction(hash: string): Promise<{ hash: string; confirmed: boolean; onChain: boolean }>;
}

export class AdapterNotConfiguredError extends Error {
  override readonly name = 'AdapterNotConfiguredError';
  constructor(readonly adapterId: string, readonly requires: string[]) {
    super(
      `${adapterId} は未接続（区分B）。実接続には ${requires.join(' / ')} が要る。` +
        'もっともらしい応答を作って先に進めない',
    );
  }
}
