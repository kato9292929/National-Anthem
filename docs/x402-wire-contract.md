# x402 の実ワイヤ（稼働プロダクトからの引き写し）

推測ではなく、実 tx が出ている稼働リポジトリの実装から取った値と形。
**出どころを各項目に付ける。** 出どころの無い値は入れない。

読んだリポジトリ（このセッションで clone した時点の HEAD）:

| 略称 | リポジトリ | 役割 |
| --- | --- | --- |
| X-alpha | `kato9292929/x-alpha` (`f3600c9`) | 402 を出す側（資源サーバ）。Solana leg |
| OSD | `kato9292929/onchain-stock-data` (`71e28d3`) | 402 を出す側。Base + Solana の 2 レール |
| AA | `kato9292929/x402-Autonomous-Agent-` | 払う側（クライアント）。Base / Solana |

## 1. トランスポート

| 項目 | 値 | 出どころ |
| --- | --- | --- |
| 要求の載せ方 | `PAYMENT-REQUIRED` レスポンスヘッダに base64 JSON。**body は `{}`** | X-alpha `src/x402/handler.ts`（`paymentRequired`）／`accepts.ts` の冒頭コメント |
| top-level | `x402Version: 2` | X-alpha `src/x402/accepts.ts` `buildRequirements` |
| 支払いヘッダ | `PAYMENT-SIGNATURE`（base64 JSON） | X-alpha `src/x402/handler.ts` `readPaymentSignature` / `decodePaymentSignature` |
| settle 結果 | `PAYMENT-RESPONSE`（base64 JSON）。**成功時も失敗時も返す** | X-alpha `src/x402/handler.ts` |
| scheme | `exact` | X-alpha `src/x402/config.ts`（`scheme: 'exact'`）／OSD `docs/x402-solana-reference.md` §1 |

## 2. accepts（v1 と v2 の併記）

`accepts` には **2 本**入れる。値は同じで、金額のフィールド名と network の形だけが違う。

| leg | network | 金額フィールド |
| --- | --- | --- |
| v1 | `solana`（bare） | `maxAmountRequired` |
| v2 | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`（CAIP-2） | `amount` |

出どころ: X-alpha `src/x402/accepts.ts`（`buildAccepts` が両方を返す。コメントに
「現行 AA は v2-only の accepts を拒否する」と理由まで書かれている）。

各 leg に必須のフィールド（欠けると facilitator の verify が
`invalid_payment_requirements` で落ちる、と X-alpha のコメントに実測が残っている）:

`scheme` / `network` / `resource` / `description` / `mimeType` / `maxTimeoutSeconds` /
`asset` / `payTo` / `extra.resource` / `extra.feePayer`

`maxTimeoutSeconds` は 300（X-alpha `config.ts`）。`mimeType` は `application/json`。

## 3. feePayer は動的

PayAI は feePayer をローテートする（X-alpha `src/x402/feePayer.ts` に
`D6Zht… → BFK9… → 2wKup…` の観測履歴が残っている）。

- 取得元: facilitator の **`/supported`**（X-alpha `feePayer.ts` `defaultFetchSupported`）
- 応答は形が変わりうるので、`feePayer` キーを総なめして拾う（同 `extractFeePayer`）
- 短い TTL で握る（既定 300000ms）
- **取れなくても accepts を空にしない**。feePayer 無しで leg は返す

National Anthem 側の実装: `packages/server/src/x402/challenge.ts` の `FeePayerResolver`。
config には feePayer の実値を置かない（置くと検証で落ちる）。

## 4. facilitator の wire

```
POST {facilitator}/verify   body: { x402Version, paymentPayload, paymentRequirements }
POST {facilitator}/settle   body: { x402Version, paymentPayload, paymentRequirements }
```

- `paymentPayload` は **base64 を解いたオブジェクト**（生の base64 文字列ではない）
- `paymentRequirements` は **突き合わせた 1 本の leg**（accepts 全体ではない）。
  相手が主張する条件ではなく、こちらが出した leg を送る
- verify 応答: `{ isValid, invalidReason?, invalidMessage?, payer? }`
- settle 応答: `{ success, transaction, network, errorReason?, errorMessage?, payer? }`

出どころ: X-alpha `src/x402/payment.ts`（`@x402/core 2.17.0` の `HTTPFacilitatorClient` を
npm pack で読んで確認した、と明記されている）。

## 5. レールごとの確定値

| 項目 | Solana | Base |
| --- | --- | --- |
| network (v2) | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `eip155:8453` |
| network (v1) | `solana` | `base` |
| asset | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| payTo | `4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf` | **未指定**（National Anthem 用の受取先が要る） |
| facilitator | PayAI `https://facilitator.payai.network` | OSD は CDP（`@coinbase/x402`）を使っている |
| 金額 | 0.01 USDC = `"10000"`（6 桁） | 同左 |

出どころ: Solana は X-alpha `src/x402/config.ts`、Base は OSD `lib/x402.ts`
（`BASE_NETWORK` / `ASSET_BASE_USDC`）と AA `src/x402.ts`（`register("eip155:8453", …)`）。

**Base の payTo だけは稼働コードにも National Anthem 用の値が無い**ので `TBD` のまま。
埋まるまで Base rail は `confirmed: false`で、402 を出そうとすると落ちる。

## 6. 署名（払う側）

**自前で payload を組まない。** 公式 SDK に委ねる。出どころは AA `src/x402.ts`:

```ts
const client = new x402Client()
  .register("eip155:8453", new ExactEvmScheme(signer))   // Base
  .registerV1("base", scheme)
  .registerPolicy((_v, reqs) => reqs.filter((r) => BigInt(r.amount) <= cap));
registerExactSvmScheme(client, { signer });               // Solana
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
```

- Solana: `@solana/kit` の `createKeyPairSignerFromBytes(base58.decode(SOLANA_PRIVATE_KEY))`。
  秘密鍵は base58 の 64 byte keypair
- Base: `viem` の `privateKeyToAccount`、または Circle DCW
  （AA `src/circle/evm-signer.ts`: `POST https://api.circle.com/v1/w3s/developer/sign/typedData`、
  body `{ walletId, data, entitySecretCiphertext }`。`data` は
  `{domain, types, primaryType, message}` を JSON 文字列にしたもので、
  **`types` に `EIP712Domain` を足す**（viem/x402 は省くが Circle は要求する））
- EIP-712 domain: `name="USD Coin"` / `version="2"` / `chainId=8453` /
  `verifyingContract` は leg の `asset`（Base USDC のトークンアドレス）

National Anthem 側: `packages/server/src/x402/sdk-payer.ts`。鍵が無ければ作らず、
`SdkPayerUnavailableError` で落ちる（偽署名は作らない）。

## 7. 既知の落とし穴（実測の記録）

- **v1 leg には `amount` が無い。** AA の金額上限ポリシーが `BigInt(r.amount)` を読むため、
  Solana の v1 leg が `BigInt(undefined)` で throw → 全 drop → `filtered out` になっていた
  （OSD `docs/x402-solana-reference.md` の「真因」）。払う側のポリシーは
  `amount ?? maxAmountRequired` を見る必要がある
- **空の 402 はバグではない。** `@x402/core` の `createHTTPResponse` は body `{}` ＋
  `PAYMENT-REQUIRED` ヘッダを返す（v1 は body、v2 はヘッダ）。これを「空 402＝バグ」と誤認して
  self-build に作り替えたのが OSD の回り道だった
- **OSD の Solana は本番で 1 本も通っていない**（日次で ref 付き 200 が出ているのは Base のみ）。
  「動くコピー元」として Solana 経路を無条件に信用しない

## 8. National Anthem 側の対応

| 実装 | 場所 |
| --- | --- |
| 402 を出す（資源のゲート） | `packages/server/src/x402/challenge.ts` / `paywall.ts`。commission の封印精算と物販の購入をゲートする |
| 払う（実支払い） | `packages/server/src/x402/sdk-payer.ts`（公式 SDK） |
| 区分A の一周確認 | `packages/server/src/x402/client.ts`（内製。mock facilitator 相手の確認用で、実支払いには使わない） |
| 検証 | privacy Gateway 経由（返るのは `payment_valid` のみ）。実 MXE が無い間は facilitator へ委ねる。**常に true を返す stub でゲートは開けない** |
