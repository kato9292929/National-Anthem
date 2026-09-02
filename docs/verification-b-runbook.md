# 区分B の実確認ランブック

区分B = 実キー・実ネットワークが要る確認。**実装が終わったことと、実確認が通ったことは別**。
`verified: true` にできるのは、`config/verification-evidence.json` に証拠レコードがある項目だけで、
証拠の無い `true` はサーバ起動時とテストで落ちる。

実行: `npm run verify:b`（レポートは `artifacts/verification-report.json`）

## 現状（この開発環境で実行した結果）

5 段すべて blocked。**`verified` はすべて `false` のまま**、証拠レコードは 0 件。
ただし**仕様の欠けはほぼ解消した**（稼働リポジトリから引き写した。`docs/x402-wire-contract.md`）。
残っているのは主に鍵とネットワークと、下の 2 点。

| 段 | 状態 | 止まっている理由 |
| --- | --- | --- |
| 2. 実署名 | blocked | `NA_SOLANA_PRIVATE_KEY` 未設定。**仕様は解消**（公式 SDK に委ねる形を AA から引き写した） |
| 1. 実 facilitator・実着金（Solana） | blocked | egress が `facilitator.payai.network` を拒否／`NA_X402_PAYWALL` 未設定／2 が未了。**資源は自前のエンドポイントで用意済み** |
| 1b. Base レールの着金 | blocked | `NA_EVM_PRIVATE_KEY` 未設定／egress／**Base の payTo（受取先）が未指定** |
| 3. 実 MXE | blocked | `NA_ARCIUM_CLUSTER_URL` / `NA_ARCIUM_MXE_ID` 未設定。**実計算の呼び出し形は Arcium リポジトリでも未実装**（下記） |
| 4. 実 identity | blocked | `NA_BASE_RPC_URL` 未設定。**レジストリのアドレスと ABI は解消**（AA から引き写した） |

この環境は外向き通信が allowlist 制で、`facilitator.payai.network` / Solana RPC / Base RPC / Circle API は
いずれも 403 で拒否される。鍵も入っていない。したがってここでは 1 件も実確認できない。

### 仕様の出どころ（推測していない）

| 何 | どこから取ったか |
| --- | --- |
| 402 の形・accepts・facilitator の wire | `kato9292929/x-alpha` `src/x402/*` |
| Base の network / asset / facilitator 構成 | `kato9292929/onchain-stock-data` `lib/x402.ts` |
| 署名（クライアント）の組み方・Circle DCW の署名 API | `kato9292929/x402-Autonomous-Agent-` `src/x402.ts` / `src/circle/evm-signer.ts` |
| ERC-8004 レジストリのアドレスと ABI | 同 `src/erc8004/contract.ts`（Base mainnet `0x8004A169…a432`） |

詳細は `docs/x402-wire-contract.md`。

### Arcium の実 MXE は、参照先でも未実装

`kato9292929/Arcium` の `gateway/src/lib/arcium.ts` に、そのリポジトリ自身の言葉で

> Only the MOCK path below is implemented and exercised. The "real" path is NOT wired up to the
> Arcium network — calling it throws NotImplemented.
> …real computations are asynchronous: the gateway queues a computation on-chain and receives the
> result via callback/polling — there is no synchronous request→response `executeMXE` call.

と書かれている（mock は XOR で、暗号ではないとも明記されている）。
つまり**実 MXE の呼び出し形はここから取れない**。`@arcium-hq/client` を使った実装が別途要る。
それまで `privacy.gateway.verified` は上がらない。

なお National Anthem 側では、実 MXE が無い間の検証を**「常に true を返す stub」にはしていない**。
facilitator へ委ねる形にし、検証も settle もできない状態では資源のゲート自体を開けないようにした
（`NA_X402_PAYWALL=1` を facilitator 無しで指定すると起動時に落ちる）。

## 段ごとに要るもの

### 2. 実署名（先に通す）

| 種別 | 要るもの |
| --- | --- |
| 鍵 | Solana 生 keypair（`6JKVugbVRXR92sacDzgxBU6k6Mb9AAhxLbEy3DyWvEzA` の秘密鍵）を `NA_SOLANA_PRIVATE_KEY` に。Base は `NA_EVM_PRIVATE_KEY` か Circle DCW 一式 |
| 仕様 | **解消**。payload は自前で組まず公式 SDK に委ねる（AA と同じ形）。`packages/server/src/x402/sdk-payer.ts` |

Circle DCW での EVM 署名は、AA の `sign/typedData` 経路（`types` に `EIP712Domain` を足す）を
そのまま使う形で組む。資格情報の扱いがあるので実装は実環境で仕上げる。

### 1. 実 facilitator 疎通と実着金

| 種別 | 要るもの |
| --- | --- |
| ネットワーク | `facilitator.payai.network` への到達（この環境では egress allowlist に無い） |
| 設定 | `NA_X402_PAYWALL=1`。**資源は用意済み**: 委託の封印精算（`POST /api/commission/action` の `settle`）と物販の購入（`POST /api/storefront/buy`）を 402 でゲートする |
| 前提 | 2（実署名）が通っていること |

Base レールは受取先（payTo）が未指定なので、埋まるまで 402 を出せない
（`config/x402.config.json` の `rails[base].payTo` が `TBD` の間は `confirmed:false`）。

確定値は config に入っている（facilitator URL / payTo / USDC mint / CAIP-2 / `"10000"` 6 桁 / native withX402 v2）。
feePayer は 402 の `extra.feePayer` から毎回取る実装で、config には持たせていない。

### 3. 実 Arcium MXE 投入と実 RPC

| 種別 | 要るもの |
| --- | --- |
| ネットワーク | MXE クラスタの URL（`NA_ARCIUM_CLUSTER_URL`）と実 RPC |
| 仕様 | 検証回路の呼び出し形（何を渡して `payment_valid` を受けるか） |

Gateway 側の受け口は実装済みで、`payment_valid` 以外が返れば落とす・ログに残さないところまでは通っている。
URL を渡せば HTTP クライアントとしては動くが、**通信できたことと検証が正しいことは別**なので、
実 MXE で検証が通るまで `verified` は上げない。

### 4. 実 identity

| 種別 | 要るもの |
| --- | --- |
| ネットワーク | Base の RPC（`NA_BASE_RPC_URL`）。Arc Testnet 側のレジストリは未確認 |
| 仕様 | **解消**（Base）。レジストリ `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`（chainId 8453）と
`getAgentWallet` / `tokenURI` の ABI を config と `packages/server/src/adapters/erc8004.ts` に取り込んだ |

`NA_BASE_RPC_URL` を渡せば実照会に向く。照会が通るまで `verified` は false のまま。
Arc Testnet（agentId `845265`）のレジストリアドレスは稼働コードにも無いので、そこは未確認のまま置いている。

## 証拠の書き方

実確認が通ったら、`config/verification-evidence.json` の `records` に追記する
（`npm run verify:b` が通った段について自動で追記する）。

```json
{
  "target": "x402.rails.solana",
  "kind": "settlement",
  "at": "2026-09-01T00:00:00Z",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "evidence": { "txHash": "…", "explorerUrl": "https://…" },
  "observedBy": "npm run verify:b",
  "note": "payTo への 0.01 USDC 着金を確認"
}
```

`target` は config 側の `verified` フラグに 1 対 1 で対応する:

| target | どの `verified` を裏付けるか |
| --- | --- |
| `x402.facilitator` | `config/x402.config.json` の `facilitator.verified` |
| `x402.rails.<id>` | 同 `rails[].verified` |
| `identity.erc8004.<id>` | `config/identity.config.json` の `external_assets.erc8004[].verified` |
| `identity.signers.<id>` | 同 `external_assets.signers[].verified` |
| `identity.custodial_wallets.<id>` | 同 `external_assets.custodial_wallets[].verified` |
| `privacy.gateway` | `config/privacy.config.json` の `gateway.verified` |

証拠を入れずに `verified: true` にすると、サーバ起動とテストが `UnbackedVerificationError` で落ちる。
