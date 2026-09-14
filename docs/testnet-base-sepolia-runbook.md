# Base Sepolia（testnet）で実決済を 1 件通す — runbook（区分B）

mock で動いている決済フローを、Base Sepolia（testnet）＋ faucet で実チェーンに通す。実 tx を 1 件出す。
testnet なので実弾（本物の USDC）は不要。mainnet は対象外。

**到達点**: 決済デモの 4 段（402 受信 → 署名 → payment_valid → 清算）が、mock でなく実 Base Sepolia の tx で settle し、
画面と証拠ファイルに実 tx hash が残る。人間の購入 1 件で可。

CC のサンドボックスは egress allowlist で Base Sepolia RPC / facilitator に出られないため、**この runbook は加藤さんの環境で実行する**。
コードは区分A で実装・型・テスト済み（鍵/ネットが無ければ fail-loud、`verified` は false のまま）。

## 1. 用意するもの

- **testnet 用の EVM wallet と鍵**（`0x…`）。mainnet の鍵は使わない。
- **faucet で testnet USDC と gas（Base Sepolia ETH）** を上の wallet に入れる。
  - Base Sepolia ETH（gas）: Base の faucet（例: [Base faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet) / [Alchemy](https://www.alchemy.com/faucets/base-sepolia)）。
  - testnet USDC: [Circle faucet](https://faucet.circle.com/)（Base Sepolia を選ぶ）。asset は `0x036CbD53842c5426634e7929541eC2318f3dCF7e`。
  - ガススポンサー構成（facilitator が gas を持つ）なら wallet の ETH は最小で可。USDC は購入額（0.001 USDC）以上。
- **testnet 対応の x402 facilitator のエンドポイント**（PayAI の testnet、または x402 public testnet facilitator）。
- **Base Sepolia RPC**（例: `https://sepolia.base.org`）。実 tx の receipt 確認に使う。
- **egress allowlist に追加**: facilitator のホストと RPC のホスト。

## 2. config を確定する（`config/x402.config.json` の `base-sepolia` rail）

- `payTo`: 受取先（自分の testnet アドレス）を入れる。
- `confirmed`: `true` にする（payTo を入れてから）。
- `eip712Domain.name` / `version`: 実際の testnet USDC contract から確認する（`0x036CbD53842c5426634e7929541eC2318f3dCF7e` の `name()` / EIP-5267 `eip712Domain()`）。
  - 署名の EIP-712 domain は公式 SDK（`@x402/evm`）が network から導出するので、この値は runbook 用の記録。
  - 分かった値に更新し、`confirmed: true` にしてよい（推測で埋めない。確認できるまで false のまま）。
- `facilitator.url`: testnet facilitator を使うなら、そのエンドポイントに差し替える（または env の `NA_X402_FACILITATOR_URL` で上書き）。

## 3. env（`.env`）

```
NA_X402_TESTNET=1
NA_X402_PAYWALL=1
NA_X402_RAIL=base-sepolia
NA_X402_FACILITATOR_URL=<testnet facilitator のエンドポイント>
NA_EVM_PRIVATE_KEY=<testnet 用の 0x 秘密鍵>
NA_BASE_SEPOLIA_RPC_URL=<Base Sepolia RPC>
```

- `NA_X402_TESTNET=1` には `NA_X402_PAYWALL=1` が要る（払う先の資源が自分の paywall。実 facilitator も要る）。無いと起動時に落ちる。
- 鍵・facilitator・確定した rail のどれかが欠けると、決済は fail-loud で失敗する（偽署名・偽 tx は作らない）。

## 4. 実決済を 1 件通す（録画つき）

```
npm run build
npm run smoke:testnet
```

- 人間の購入 1 件が実 Base Sepolia で settle する。画面（`x402 決済フロー` パネル）に 4 段が点灯し、
  banner は「Base Sepolia testnet — 実 tx（mainnet ではない）」を出す。tx は **mock: を付けない実物**。
- フレーム列と要約が `artifacts/testnet-*.png` / `artifacts/testnet-payment.json` に残る（`txHash` / `txUrl` 入り）。
- 自己申告でなく **tx hash** で確認する。`artifacts/testnet-payment.json` の `txUrl`（`https://sepolia.basescan.org/tx/…`）を開く。

手で動かすなら `npm run dev:server` ＋ `npm run dev:client`（上の env つき）→ stall の前で **E → Enter**。

## 5. 証拠を記録して verified を上げる

`verified: true` にできるのは、実 tx が着金・確認できた項目だけ。

```
NA_VERIFY_BASE_SEPOLIA_TX=<smoke:testnet で出た 0x… tx hash> npm run verify:b
```

- `verify:b` が RPC の `eth_getTransactionReceipt` で status 0x1（成功）を確認できたときだけ、
  `config/verification-evidence.json` に `x402.rails.base-sepolia` と `x402.facilitator` の settlement 証拠を追記する。
- 追記後、`config/x402.config.json` の `base-sepolia` rail（と必要なら `facilitator`）の `verified` を `true` にできる
  （証拠が無いのに true にすると起動時に `UnbackedVerificationError` で落ちる）。
- receipt がまだ無い／status が成功でないときは証拠を作らない（偽の着金にしない）。

## ガードレール（維持）

- 偽署名・偽 tx・偽着金を作らない。想定外レスポンスは握りつぶさず落とす（fail-loud）。
- 画面は「Base Sepolia testnet」と明示（mainnet と誤認させない）。実 tx hash はそのまま出す（`mock:` を付けない）。
- 決済ロジックの画面（4 段フロー・購入・HUD）は触らず、settle の中身だけ実 tx に差し替える。
- mainnet 着金・実弾は今回やらない。

## 次（今回はやらない）

- エージェントが買い手として同じ実 testnet 決済を通す（人間版が通ってから）。
- mainnet 着金。Tripo/Marble の見た目差し替え。
