import type { Erc8004Registry } from '@na/shared';
import { AdapterNotConfiguredError, type Erc8004Adapter } from './types.js';

/**
 * ERC-8004 IdentityRegistry の照会。
 *
 * ABI とレジストリアドレスの出どころ:
 *   kato9292929/x402-Autonomous-Agent- src/erc8004/contract.ts（Base mainnet で登録に使ったもの）
 *   アドレスは config（external_assets.registries.erc8004）から引く。ここには書かない。
 *
 * RPC は env で渡す。渡されていなければ照会しない（偽の結果を返さない）。
 * 実照会が通るまで verified は false のまま。
 */

/** 公式 contracts の IdentityRegistry から、読み取りに使う分だけ。 */
const IDENTITY_REGISTRY_READ_ABI = [
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'getAgentWallet',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export interface Erc8004AdapterOptions {
  registry: Erc8004Registry;
  rpcUrl: string;
}

export function createErc8004Adapter(options: Erc8004AdapterOptions): Erc8004Adapter {
  const id = `erc8004:${options.registry.id}`;
  return {
    status: () => ({
      id,
      kind: 'erc8004',
      mode: 'live',
      verified: false,
      requires: ['NA_BASE_RPC_URL'],
      note:
        `${options.registry.agentRegistryId} を照会する。RPC は ${new URL(options.rpcUrl).host}。` +
        '実照会が通るまで未検証',
    }),
    async lookupAgent({ chain, agentId }) {
      if (chain !== options.registry.chain) {
        throw new AdapterNotConfiguredError(id, [`${chain} のレジストリアドレス（config に無い）`]);
      }
      // viem は実行時にだけ読む（RPC が無い環境で依存を引かないため）。
      const { createPublicClient, http } = await import('viem');
      const client = createPublicClient({ transport: http(options.rpcUrl) });
      const owner = await client.readContract({
        address: options.registry.address as `0x${string}`,
        abi: IDENTITY_REGISTRY_READ_ABI,
        functionName: 'getAgentWallet',
        args: [BigInt(agentId)],
      });
      if (typeof owner !== 'string' || !owner.startsWith('0x')) {
        throw new Error(`getAgentWallet の応答が想定外: ${String(owner)}`);
      }
      return { chain, agentId, onChain: true, owner, registeredAt: null };
    },
  };
}
