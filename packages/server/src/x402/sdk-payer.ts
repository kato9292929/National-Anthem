import type { X402Config } from '@na/shared';

/**
 * 実支払いのクライアント。
 * 署名の payload は自前で組まず、公式 SDK（@x402/fetch + @x402/evm + @x402/svm）に委ねる。
 * 稼働プロダクト（AA）と同じ組み方:
 *   x402Client()
 *     .register("eip155:8453", new ExactEvmScheme(signer))
 *     .registerV1("base", scheme)
 *     .registerPolicy(金額上限)
 *   registerExactSvmScheme(client, { signer })   // Solana は @solana/kit の keypair signer
 *   wrapFetchWithPayment(fetch, client)
 *
 * 出どころ: docs/x402-wire-contract.md（kato9292929/x402-Autonomous-Agent- src/x402.ts）。
 *
 * 鍵が無ければ作らない。偽の署名も、払えたふりもしない。
 */

export interface SdkPayerEnv {
  /** base58 の 64 byte keypair。@solana/kit の createKeyPairSignerFromBytes に渡す。 */
  solanaPrivateKey?: string | undefined;
  /** viem の privateKeyToAccount に渡す 0x 秘密鍵。 */
  evmPrivateKey?: string | undefined;
  /** Circle DCW を使う場合。 */
  circleWalletId?: string | undefined;
  circleWalletAddress?: string | undefined;
  circleApiKey?: string | undefined;
}

export interface SdkPayerStatus {
  available: boolean;
  rails: string[];
  missing: string[];
  note: string;
}

export class SdkPayerUnavailableError extends Error {
  override readonly name = 'SdkPayerUnavailableError';
  constructor(readonly missing: string[]) {
    super(
      '実支払いの鍵が無い（区分B）。' +
        `不足: ${missing.join(' / ')}。` +
        '偽の署名は作らないので、ここで止める',
    );
  }
}

/** 何が揃っていて何が足りないかを、鍵の値を出さずに示す。 */
export function inspectSdkPayer(config: X402Config, env: SdkPayerEnv): SdkPayerStatus {
  const rails: string[] = [];
  const missing: string[] = [];

  const solanaRail = config.rails.find((r) => r.id === 'solana');
  if (solanaRail?.confirmed) {
    if (env.solanaPrivateKey) rails.push('solana');
    else missing.push('NA_SOLANA_PRIVATE_KEY（base58 の 64 byte keypair）');
  }

  // EVM レール（base / base-sepolia など）。確定していて EVM 鍵があれば払える。
  const evmRails = config.rails.filter((r) => r.chainKind === 'evm');
  const circle = Boolean(env.circleWalletId && env.circleWalletAddress && env.circleApiKey);
  let anyEvmConfirmed = false;
  for (const rail of evmRails) {
    if (!rail.confirmed) continue;
    anyEvmConfirmed = true;
    if (env.evmPrivateKey || circle) rails.push(rail.id);
  }
  if (!anyEvmConfirmed) {
    missing.push('EVM rail が未確定（base / base-sepolia の payTo 未指定など）');
  } else if (!env.evmPrivateKey && !circle) {
    missing.push('NA_EVM_PRIVATE_KEY または Circle DCW の資格情報一式');
  }

  return {
    available: rails.length > 0,
    rails,
    missing,
    note: '署名の payload は公式 SDK に任せる。自前で組まない',
  };
}

/**
 * 支払い付き fetch を作る。鍵が無ければ例外。
 * SDK の読み込みは遅延させる（鍵が無い環境で依存を引かないため）。
 */
export async function createPayingFetch(
  config: X402Config,
  env: SdkPayerEnv,
): Promise<typeof fetch> {
  const status = inspectSdkPayer(config, env);
  if (!status.available) throw new SdkPayerUnavailableError(status.missing);

  const { wrapFetchWithPayment, x402Client } = await import('@x402/fetch');
  const client = new x402Client();

  const evmRailIds = config.rails.filter((r) => r.chainKind === 'evm' && status.rails.includes(r.id));
  if (evmRailIds.length > 0) {
    const { ExactEvmScheme, toClientEvmSigner } = await import('@x402/evm');
    if (!env.evmPrivateKey) {
      // Circle DCW 経由の署名口は、資格情報の扱いを含めて実環境で組む。
      throw new SdkPayerUnavailableError(['Circle DCW 署名口の実装（実環境で組む）']);
    }
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(env.evmPrivateKey as `0x${string}`);
    // 署名の payload と EIP-712 domain は公式 SDK が network から導出する（自前で組まない・推測しない）。
    const scheme = new ExactEvmScheme(toClientEvmSigner(account));
    for (const rail of evmRailIds) {
      client.register(rail.network as never, scheme).registerV1(rail.networkV1 as never, scheme);
    }
  }

  if (status.rails.includes('solana')) {
    const { registerExactSvmScheme } = await import('@x402/svm/exact/client');
    const { createKeyPairSignerFromBytes } = await import('@solana/kit');
    const { base58 } = await import('@scure/base');
    const signer = await createKeyPairSignerFromBytes(base58.decode(env.solanaPrivateKey!));
    registerExactSvmScheme(client, { signer });
  }

  return wrapFetchWithPayment(fetch, client);
}

export function sdkPayerEnvFrom(env: NodeJS.ProcessEnv): SdkPayerEnv {
  return {
    solanaPrivateKey: env['NA_SOLANA_PRIVATE_KEY'] ?? env['NA_WALLET_PRIVATE_KEY'],
    evmPrivateKey: env['NA_EVM_PRIVATE_KEY'],
    circleWalletId: env['NA_CIRCLE_EVM_WALLET_ID'],
    circleWalletAddress: env['NA_CIRCLE_EVM_WALLET_ADDRESS'],
    circleApiKey: env['NA_CIRCLE_API_KEY'],
  };
}
