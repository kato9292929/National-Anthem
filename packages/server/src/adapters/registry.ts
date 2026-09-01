import type { AdapterStatus, ChainAdapter, CustodialWalletAdapter, Erc8004Adapter, FacilitatorAdapter, MxeAdapter } from './types.js';
import {
  mockChainAdapter,
  mockCustodialWalletAdapter,
  mockErc8004Adapter,
  mockFacilitatorAdapter,
  mockMxeAdapter,
} from './mock.js';
import {
  liveFacilitatorAdapter,
  liveMxeAdapter,
  unconfiguredChainAdapter,
  unconfiguredCustodialWalletAdapter,
  unconfiguredErc8004Adapter,
} from './live.js';

/**
 * env の状態から、どの口が live に向いていてどれが mock かを決める。
 * どれも verified:false のまま。実疎通の確認は区分B。
 */

export interface AdapterRegistry {
  facilitator: FacilitatorAdapter;
  mxe: MxeAdapter;
  erc8004: Erc8004Adapter;
  custodialWallet: CustodialWalletAdapter;
  chain: ChainAdapter;
  statuses(): AdapterStatus[];
}

export interface RegistryEnvView {
  facilitatorUrl?: string | undefined;
  mxeUrl?: string | undefined;
  chainRpcUrl?: string | undefined;
  custodialCredentials?: string | undefined;
  /** 区分A の検証で mock を強制する。 */
  forceMock?: boolean;
}

export function createAdapterRegistry(env: RegistryEnvView): AdapterRegistry {
  const useMock = env.forceMock === true;

  const facilitator =
    !useMock && env.facilitatorUrl ? liveFacilitatorAdapter(env.facilitatorUrl) : mockFacilitatorAdapter(env.facilitatorUrl ?? 'http://mock.invalid');
  const mxe = !useMock && env.mxeUrl ? liveMxeAdapter(env.mxeUrl) : mockMxeAdapter();
  const erc8004 = useMock
    ? mockErc8004Adapter()
    : unconfiguredErc8004Adapter(['チェーン RPC エンドポイント', 'ERC-8004 レジストリの呼び出し形']);
  const custodialWallet = useMock
    ? mockCustodialWalletAdapter()
    : unconfiguredCustodialWalletAdapter(['Circle DCW の資格情報', 'API の呼び出し形']);
  const chain = useMock
    ? mockChainAdapter()
    : env.chainRpcUrl
      ? unconfiguredChainAdapter(['RPC の呼び出し形'])
      : unconfiguredChainAdapter(['チェーン RPC エンドポイント']);

  return {
    facilitator,
    mxe,
    erc8004,
    custodialWallet,
    chain,
    statuses: () => [
      facilitator.status(),
      mxe.status(),
      erc8004.status(),
      custodialWallet.status(),
      chain.status(),
    ],
  };
}
