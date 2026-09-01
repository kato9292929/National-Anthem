import type {
  ChainAdapter,
  CustodialWalletAdapter,
  Erc8004Adapter,
  FacilitatorAdapter,
  MxeAdapter,
} from './types.js';
import { FacilitatorClient } from '../x402/facilitator.js';

/**
 * 区分A で結線を確かめるための mock。
 * 返す値には mock: を残し、実チェーンのものに見せない。onChain は必ず false。
 */

export function mockFacilitatorAdapter(url: string, fetchImpl: typeof fetch = fetch): FacilitatorAdapter {
  const client = new FacilitatorClient(url, fetchImpl);
  return {
    status: () => ({
      id: 'facilitator:mock',
      kind: 'facilitator',
      mode: 'mock',
      verified: false,
      requires: ['NA_X402_FACILITATOR_URL'],
      note: 'ローカルの mock facilitator。実 facilitator 疎通は区分B',
    }),
    verify: (payload, leg) => client.verify(payload, leg),
    settle: (payload, leg) => client.settle(payload, leg),
  };
}

export function mockMxeAdapter(decide: () => boolean = () => true): MxeAdapter {
  return {
    status: () => ({
      id: 'mxe:mock',
      kind: 'mxe',
      mode: 'mock',
      verified: false,
      requires: ['NA_ARCIUM_CLUSTER_URL'],
      note: 'bool を返す stub。実 MXE 投入は区分B',
    }),
    verify: () => Promise.resolve({ payment_valid: decide() }),
  };
}

export function mockErc8004Adapter(): Erc8004Adapter {
  return {
    status: () => ({
      id: 'erc8004:mock',
      kind: 'erc8004',
      mode: 'mock',
      verified: false,
      requires: ['チェーン RPC エンドポイント'],
      note: '実チェーン照会は区分B。owner は mock: 前置きの仮値',
    }),
    lookupAgent: ({ chain, agentId }) =>
      Promise.resolve({
        chain,
        agentId,
        onChain: false,
        owner: `mock:owner:${chain}:${agentId}`,
        registeredAt: null,
      }),
  };
}

export function mockCustodialWalletAdapter(): CustodialWalletAdapter {
  return {
    status: () => ({
      id: 'custodial-wallet:mock',
      kind: 'custodial-wallet',
      mode: 'mock',
      verified: false,
      requires: ['Circle DCW の資格情報'],
      note: '実 wallet 発行・照会は区分B',
    }),
    getWallet: (id) =>
      Promise.resolve({
        id,
        chain: 'mock',
        address: `mock:wallet:${id}`,
        provider: 'mock',
        onChain: false,
      }),
  };
}

export function mockChainAdapter(): ChainAdapter {
  return {
    status: () => ({
      id: 'chain:mock',
      kind: 'chain',
      mode: 'mock',
      verified: false,
      requires: ['チェーン RPC エンドポイント'],
      note: '残高・トランザクション照会は区分B。金額は 0 のまま返す',
    }),
    getBalance: ({ address, asset }) =>
      Promise.resolve({ address, asset, amount: '0', onChain: false }),
    getTransaction: (hash) => Promise.resolve({ hash, confirmed: false, onChain: false }),
  };
}
