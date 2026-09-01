import type {
  ChainAdapter,
  CustodialWalletAdapter,
  Erc8004Adapter,
  FacilitatorAdapter,
  MxeAdapter,
} from './types.js';
import { AdapterNotConfiguredError } from './types.js';
import { FacilitatorClient } from '../x402/facilitator.js';
import { createHttpMxeClient } from '../privacy/gateway.js';

/**
 * 実接続側。仕様が書かれているところ（facilitator / Gateway の HTTP 形）は薄く実装し、
 * 書かれていないところ（チェーン RPC・Circle DCW の呼び出し形）は未接続として落とす。
 * 推測で API 形を作らない。どれも実疎通は未検証（verified: false）。
 */

export function liveFacilitatorAdapter(url: string, fetchImpl: typeof fetch = fetch): FacilitatorAdapter {
  const client = new FacilitatorClient(url, fetchImpl);
  return {
    status: () => ({
      id: 'facilitator:live',
      kind: 'facilitator',
      mode: 'live',
      verified: false,
      requires: ['NA_X402_FACILITATOR_URL'],
      note: `${url} に向いているが疎通は未検証（区分B）`,
    }),
    verify: (payload, leg) => client.verify(payload, leg),
    settle: (payload, leg) => client.settle(payload, leg),
  };
}

export function liveMxeAdapter(url: string, fetchImpl: typeof fetch = fetch): MxeAdapter {
  const client = createHttpMxeClient(url, fetchImpl);
  return {
    status: () => ({
      id: 'mxe:live',
      kind: 'mxe',
      mode: 'live',
      verified: false,
      requires: ['NA_ARCIUM_CLUSTER_URL'],
      note: `${url} に向いているが実 MXE 投入は未検証（区分B）`,
    }),
    verify: (input) => client.verify(input),
  };
}

/** 呼び出し形が未確定なので、繋ぐまで必ず落ちる。偽の応答を返さない。 */
export function unconfiguredErc8004Adapter(requires: string[]): Erc8004Adapter {
  const id = 'erc8004:unconfigured';
  return {
    status: () => ({
      id,
      kind: 'erc8004',
      mode: 'live',
      verified: false,
      requires,
      note: '実チェーン照会は未接続。呼び出し形が確定するまで実装しない',
    }),
    lookupAgent: () => Promise.reject(new AdapterNotConfiguredError(id, requires)),
  };
}

export function unconfiguredCustodialWalletAdapter(requires: string[]): CustodialWalletAdapter {
  const id = 'custodial-wallet:unconfigured';
  return {
    status: () => ({
      id,
      kind: 'custodial-wallet',
      mode: 'live',
      verified: false,
      requires,
      note: 'Circle DCW への実接続は未接続。資格情報と呼び出し形が要る',
    }),
    getWallet: () => Promise.reject(new AdapterNotConfiguredError(id, requires)),
  };
}

export function unconfiguredChainAdapter(requires: string[]): ChainAdapter {
  const id = 'chain:unconfigured';
  return {
    status: () => ({
      id,
      kind: 'chain',
      mode: 'live',
      verified: false,
      requires,
      note: '残高・トランザクション照会は未接続',
    }),
    getBalance: () => Promise.reject(new AdapterNotConfiguredError(id, requires)),
    getTransaction: () => Promise.reject(new AdapterNotConfiguredError(id, requires)),
  };
}
