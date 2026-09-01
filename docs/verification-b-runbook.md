# 区分B の実確認ランブック

区分B = 実キー・実ネットワークが要る確認。**実装が終わったことと、実確認が通ったことは別**。
`verified: true` にできるのは、`config/verification-evidence.json` に証拠レコードがある項目だけで、
証拠の無い `true` はサーバ起動時とテストで落ちる。

実行: `npm run verify:b`（レポートは `artifacts/verification-report.json`）

## 現状（この開発環境で実行した結果）

4 段すべて blocked。**`verified` はすべて `false` のまま**、証拠レコードは 0 件。

| 段 | 状態 | 止まっている理由 |
| --- | --- | --- |
| 2. 実署名 | blocked | `NA_WALLET_PRIVATE_KEY` 未設定／署名 payload の仕様が未確定 |
| 1. 実 facilitator・実着金 | blocked | egress ゲートウェイが `facilitator.payai.network` を拒否／402 を返す実リソースが未指定／2 が未了 |
| 3. 実 MXE | blocked | `NA_ARCIUM_CLUSTER_URL` 未設定／回路の呼び出し形が未確定 |
| 4. 実 identity | blocked | レジストリのアドレスと ABI が未指定／チェーン RPC が未指定／DCW API の呼び出し形が未確定 |

この環境は外向き通信が allowlist 制で、`facilitator.payai.network` / Solana RPC / Base RPC / Circle API は
いずれも 403 で拒否される。鍵も入っていない。したがってここでは 1 件も実確認できない。

## 段ごとに要るもの

### 2. 実署名（先に通す）

| 種別 | 要るもの |
| --- | --- |
| 鍵 | Solana 生 keypair（`6JKVugbVRXR92sacDzgxBU6k6Mb9AAhxLbEy3DyWvEzA` の秘密鍵）を `NA_WALLET_PRIVATE_KEY` に。Circle DCW を使うなら DCW の資格情報 |
| 仕様 | **X-PAYMENT の payload の形**（Solana でどのトランザクションの何に署名し、どのフィールドで載せるか）。**Base の署名方式**（EIP-3009 の `transferWithAuthorization` か permit か）と `chainId`・`verifyingContract`。Circle DCW の署名 API の呼び出し形 |

いま確定しているのは EIP-712 domain の `name="USD Coin"` / `version="2"` だけで、
domain の残り（chainId・verifyingContract）と署名対象の型は未指定。ここを推測で埋めると
偽の署名を作ることになるので、実装していない（`unavailableSigner` が必ず例外を投げる）。

### 1. 実 facilitator 疎通と実着金

| 種別 | 要るもの |
| --- | --- |
| ネットワーク | `facilitator.payai.network` への到達（この環境では egress allowlist に無い） |
| 仕様 | **402 を返す実リソースのエンドポイント**。x402 は「払って資源を取る」プロトコルなので、支払い先の資源が要る |
| 前提 | 2（実署名）が通っていること |

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
| ネットワーク | Base / Arc Testnet の RPC |
| 仕様 | ERC-8004 レジストリのコントラクトアドレスと照会関数の ABI。Circle DCW の wallet 照会・発行 API の呼び出し形 |

agentId（Base `55560` / Arc Testnet `845265`）と DCW のアドレスは config に入っている。
照会の当て先と関数が分からないので、`unconfiguredErc8004Adapter` は呼ばれたら「何が要るか」を出して落ちる。

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
