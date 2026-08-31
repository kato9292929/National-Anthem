# National Anthem

## 現状

世界設定の確定分と、M0（scaffold）／M1（サーバ権威の市場シム）／M2（歩けるグレイボックス）の実装が入っている。

| パス | 中身 |
| --- | --- |
| `packages/shared` | 型・world config ローダ・命名解決・シード付き乱数。サーバとクライアントの契約 |
| `packages/server` | 市場シム（サーバ権威・決定論）と HTTP API |
| `packages/client` | WebGL 一人称クライアント。グレイボックスの市場空間と HUD |
| `config/` | world 以外の設定（identity・room・以降のマイルストーン分）。ソースにリテラルを書かない |
| `scripts/smoke.mjs` | 実ブラウザでの受け入れ確認（stall・市場値の出所・歩行・当たり・フレーム） |
| `docs/world-spec-v0.md` | 世界設定スペック v0（正典）。差別化指示書 §3「世界設定と固有名」と「経済の重心」の確定分 |
| `world/world.config.json` | 上記の機械可読版。固有名・取引カテゴリ・参加者モデル・経済の重心・演出パラメータ |

正典は `docs/world-spec-v0.md`。config と矛盾したらドキュメントが勝つ。

## 経済の重心（確定）

**交易代理＋記録（commission / consignment ＋ 封印精算）**。物販ストアフロントは副次モジュール。

- 主モジュール: 委託・受発注ボード（commission board）。v0 の M7（バウンティ板・escrow・arbitration）を昇格。
- 副モジュール: 物販ストアフロント（stall 買い物）。主モジュールに従属。

詳細は `docs/world-spec-v0.md` §4、機械可読は `world.config.json` の `economy`。

## 開発

```sh
npm install
cp .env.example .env      # NA_MARKET_SEED が無いとサーバは明示して停止する
npm run build             # shared -> server -> client
npm test                  # サーバのテスト（config / env / 市場シム / API）
npm run sim -- --ticks 200 --every 40 --shock-at 60   # ヘッドレスで市場を回す
npm run dev:server        # http://localhost:8787
npm run dev:client        # http://localhost:5173（/api はサーバへプロキシ）
npm run smoke             # Chromium で M2/M3 の受け入れを確認し artifacts/ に画面を残す
npm run agent:dry-run     # M6 の dry-run。1 サイクルのトークン量とコストを出す（LLM 呼び出し 0）

# config 差し替えだけで表示が変わることの確認（ソースは触らない）
NA_WORLD_CONFIG=path/to/other.config.json npm run smoke
```

クライアントの操作: クリックでポインタロック → WASD 移動 / マウス 視点 / Shift 走り / Esc 解除。
stall の前に立つと、その品目の価格・在庫・進行中のショックが右上に出る。

### API

| ルート | 中身 |
| --- | --- |
| `GET /api/health` | 稼働確認（tick / seed） |
| `GET /api/world/config` | world config と解決済みの固有名・未確定リスト |
| `GET /api/market/state` | 現在の market state（品目・価格・在庫・進行中のショック） |
| `POST /api/market/shock` | 供給ショックの手動フック |
| `GET /api/commission/board` | 委託の一覧・escrow・係争・主/副モジュールの順位 |
| `POST /api/commission/action` | 委託の操作（open / propose / agree / fund / leg / settle / refund / dispute / resolve） |
| `GET /api/storefront/listing` | 物販（副モジュール）の品揃え。価格・在庫は M1 の市場状態 |
| `POST /api/storefront/buy` | 物販の購入 |
| `GET /api/agent/status` | モデル・キャッシュ・tick・予算・稼働前ゲートの判定（秘密は出さない） |
| `GET /api/privacy/status` | Gateway の状態・記録方針・claim の線（秘密は出さない） |
| `GET /api/x402/status` | x402 の protocol / facilitator / レール状態・署名可否（秘密は出さない） |
| `GET /api/identity/session` | identity・wallet・standing・room gate の現在値 |
| `POST /api/identity/rotate` | session wallet の rotate（評判は残る） |
| `POST /api/identity/reputation` | 評判イベントの記録（開発用フック。実運用では M7 の commission 完了から積む） |

### マイルストーンの状態

| M | 中身 | 状態 |
| --- | --- | --- |
| M0 | scaffold（パッケージ構成・config ローダ・env の枠・ラベル運用） | 済 |
| M1 | サーバ権威の市場シム（決済もLLMも無し） | 済 |
| M2 | 歩けるグレイボックス・クライアント | 済 |
| M3 | identity & wallet（standing / room gate） | 済（区分A）／実照会は区分B 未消化 |
| M4 | x402 決済の配線（native withX402 v2） | 済（区分A）／実 facilitator・実着金は区分B 未消化 |
| M5 | privacy 層（x402 Private Gateway / Arcium MXE） | 済（区分A）／実 MXE 投入・実 RPC は区分B 未消化 |
| M6 | エージェント自律（LLM） | 実装済・**稼働前ゲート未達のため schedule では回していない** |
| M7 | commission board（主）＋escrow＋arbitration＋物販（副） | 済（区分A）／`commission_flow` は未確定のまま |
| M3 以降 | identity/wallet、x402 決済、Arcium、エージェント自律、commission board | 別指示待ち |

M0〜M2 は LLM も決済も呼ばない。課金要素ゼロ。

## 検証区分

外部サービスのライブ検証は着手のブロックゲートにしない。検証は 2 つに分ける。

| 区分 | 中身 | 状態 |
| --- | --- | --- |
| A: 実行環境内で完結 | ビルド・型・テスト・市場シム・描画・mock を通した一周 | `npm test` と `npm run smoke` で通る |
| B: 加藤さん環境で消化 | 実 ERC-8004 照会、実 Circle DCW の wallet 発行、実チェーン残高 | **未消化**。該当箇所は `verified: false` と「未検証」ラベル付き |

区分Bが未消化でも実装は進める。条件は「記載仕様にのみ従う／未検証ラベルをコードと README に残す／
想定外レスポンスは握りつぶさず大きく失敗する」。

### 未検証（区分B）の一覧

| 箇所 | 内容 |
| --- | --- |
| `config/identity.config.json` の `external_assets` | ERC-8004（Base #55560 / Arc Testnet #845265）、AA 署名鍵、Circle DCW の EVM/Solana wallet。すべて確定値だが `verified: false` |
| session wallet のアドレス | `mock:` 前置きの仮アドレス。実チェーン上に存在しない。実キー発行は区分B |
| 認証 | 未実装。ローカルの単一 session identity（仮）で通している |
| `config/x402.config.json` の facilitator | `https://facilitator.payai.network`（PayAI）。疎通は未検証 |
| x402 の実署名 | Solana keypair / EVM EIP-712 の実署名は未実装。鍵が無いレールは `unavailableSigner` で落ちる（別レールに振り替えない） |
| 実レール着金 | 未検証。区分A は mock facilitator と mock リソースサーバで一周を確認 |
| LLM のトークン実測 | dry-run はローカル概算。`count_tokens` による実測と実 API 呼び出しは未消化 |
| 料金表 | `config/agent.config.json` の `pricing`（as_of 2026-06-24）は変動するので未検証扱い |
| Arcium MXE / Gateway | `config/privacy.config.json` の gateway URL は未指定（`TBD`）。実 MXE 投入・実 RPC は未検証。区分A は bool を返す mock MXE で結線を確認 |

## x402（M4）

native withX402 v2。402 は `PAYMENT-REQUIRED` ヘッダで来て body は `{}`、top-level に `x402Version: 2`、
leg は `amount`。確定値は `config/x402.config.json` に置き、ソースにリテラルを書かない。

- **feePayer はハードコードしない。** 402 の `accepts[].extra.feePayer` から毎回読む。
  config に置くと検証で落ちる（`feePayer.hardcodedAllowed: false`、rails に `feePayer` キーがあれば例外）。
- **レールは資産・ネットワークの完全一致でだけ選ぶ。bridge しない。**
  払えないレールしか無ければ、別レールに振り替えず落ちる。
- Solana レール（確定）: USDC `EPjFWdd5…yTDt1v` / CAIP-2 `solana:5eykt4…qZKvdp` / payTo `4s8XQC…x3VPf` /
  0.01 USDC = `"10000"`（6 桁）。
- Base の EIP-712 domain は `name: "USD Coin"` / `version: "2"`（`"USDC"` にしない）。
  payTo と asset は未指定なので rail 自体は `TBD`。
- per-call の件数を成長指標にしない。精算は M7 の commission の account 締めに紐付く。

区分A の一周（mock facilitator + mock リソースサーバ）で、402 → `X-PAYMENT` 再送 → settle 検証まで通る。

## privacy 層（M5）

検証は MXE（MPC クラスタ）の中で走り、**返るのは `payment_valid` だけ**。
送金元・金額・エンドポイントは受け取らないし、ログにも KV にも残さない。
封印タブレット（case tablet）と同じ形（world-spec §1）。

- 許可外のフィールドが返ってきたら**黙って捨てずに落とす**。機密化できていないことに気づけなくなるため。
- 決済記録に書けるのは `payment_valid` と業務側の参照だけ。アドレスらしき文字列は書き込み時に検査して落とす
  （EVM `0x…40桁` / Solana base58 / `mock:` 前置き）。
- **ミキサーは実装しない。追跡不能化を謳わない。** 送金の秘匿ではなく検証の機密化。
  この線は config の `claims`（`mixer: false` / `untraceability: false`）で固定し、
  違う値を入れると config 検証が落ちる。

## エージェント自律（M6）

市場の動きは M1 の決定論で回す。LLM は**本当に推論が要る判断**（quoting・受託判断）だけに使う。

### 稼働前ゲート

`config/agent.config.json` が満たすまで `startAgentLoop` は例外で止まる。実測前に schedule で回さない。

| # | 条件 | 現状 |
| --- | --- | --- |
| 1 | 判定・quoting は Haiku / Sonnet から。opus 全採用にしない | 充足（quoting/judgement `claude-haiku-4-5`、escalation `claude-sonnet-5`。`opusAllowed: true` は config 検証で落ちる） |
| 2 | prompt caching を固定プレフィックス＋可変の順で組む | 充足（system に `cache_control: ephemeral`、可変値は messages 側。固定側に tick・価格を混ぜない） |
| 3 | tick 頻度と 1 回あたり入力トークン量の確定 | **未達**（`cadence` が null・`confirmed: false`。加藤さん確定待ち） |
| 4 | spend limit の実数ハードキャップ＋通知 | 充足（`hardCapUsd: 5.0` / `warnAtUsd: 2.5` / 通知あり） |
| 5 | auto-reload を垂れ流しにしない | 充足（`autoReload: true` は config 検証で落ちる） |
| — | dry-run の実測 | 充足（`npm run agent:dry-run`） |

### dry-run の実測（この環境）

`npm run agent:dry-run` の結果: 1 サイクル 7 呼び出し / 入力 2,432 トークン（うちキャッシュ読み 1,122）/
出力 2,240 トークン（想定値・仮値）/ **0.0129 USD**。ハードキャップ 5 USD の内側。
トークン数はローカル概算（`local-estimate`）で**未検証**。実測は API キーのある環境で
`count_tokens`（`ApiTokenCounter`）を通す（区分B）。

料金表は claude-api の一覧（as_of 2026-06-24）を config に置いている。変動するので `verified: false`。

## commission board（M7・経済の重心）

主モジュールは commission board、物販ストアフロントは副モジュール（`config/commission.config.json`）。
principal が委託を出す → 代理エージェントが各レグを実行する → **封印精算で account を締める**。

- **締結は両者合意でのみ確定する。** 片方の合意では state が進まない。
- **escrow は release / refund の両方を持つ。** 締結前には積まない。二重 release / 二重 refund をしない。
  release は封印精算の検証（`payment_valid`）が通ってからで、検証の中身は受け取らない（M5）。
- **arbitration は release / refund の二択。** 分割は未定義なので実装しない。当事者は arbiter になれない。
- **commission の結末が standing に積まれる**（M3 へ接続）。完了は加点、不履行は減点、係争は勝敗で±。
- `commission_flow`（legs / remote_handling / settlement_unit）は **未確定のまま**。
  委託は与えられたレグの数だけを持ち、`provisional: true` を付けて回る。金額は最小単位の整数文字列、
  単位は `TBD`。推測で埋めていない。
- 物販は主モジュールを参照しない（構造としてもテストで固定している）。

区分A の一周は `npm run smoke` が実サーバに対して通す:
委託 → 片方の合意では締結しない → 両者合意で締結 → escrow → レグ → 封印精算 → release →
`payment_valid` だけの記録が残る。

## 実装するときの決まり

- 固有名（市場名・地区名・NPC・stall）はソースにリテラルで書かず、`world/world.config.json` から引く。
- `confirmed: false` は未確定。UI に出す前に確定を取るか、仮値と分かる形で出す。
- 見た目（配色・アセット・レイアウト・UI）は範囲外。`presentation` ブロック（現在すべて `TBD`）にだけ置く。
  クライアント側のグレイボックスの値は `packages/client/src/greybox.ts` の 1 ファイルにまとめ、ロジックへ散らさない。
- identity と wallet を混ぜない。wallet は rotate / revoke できる入れ物で、評判は identity に付く。
- クライアントは市場を持たない。相場・在庫はサーバ（M1）の値だけを描く。取得に失敗したら画面に出す（古い値を新しい値として見せない）。
- 物販と受発注は別モジュール。順位は `economy.modules` が持つ。物販側の都合で commission board の仕様を曲げない。
- ancient world プロジェクトの資産・データ（aw-data）・禁則は流用しない。共有するのは美学のインスピレーションのみ。

## 仮値で埋めた箇所（実装側）

| 箇所 | 内容 | 差し替えの条件 |
| --- | --- | --- |
| `packages/server/src/market/tuning.ts` | 市場の数値（基準価格・在庫・補充・消費・弾力性・ショック確率）はすべて仮値 | v0 の経済仕様が確定したら、このファイルの差し替えで済む |
| `packages/server/src/index.ts` の `TICK_INTERVAL_MS` | tick の実時間間隔（1000ms）は仮値 | 同上 |
| `packages/client/src/greybox.ts` | グレイボックスの色・寸法・移動速度。確定した見た目ではない | ビジュアル確定時。この層を差し替える／上に重ねる |
| `packages/client/src/hud.ts` の `PLACEHOLDER_HUD` | inventory / credits / 接続エージェント数はゼロ固定のプレースホルダ（画面にも「仮値」と出る） | M3（identity/wallet）以降 |
| `scripts/smoke.mjs` の `FRAME_BUDGET_MS` | ヘッドレス（SwiftShader）向けの緩い予算 50ms | 対象デバイスが決まったら実機基準へ |
| `config/x402.config.json` の `base` / `evm-secondary` レール | network / asset / payTo が未指定なので `TBD`・`confirmed:false`。使おうとすると落ちる（推測で埋めない） | 値が確定したら config 差し替え |
| `config/identity.config.json` の `standing` | 初期値・重み・上下限は仮値（`confirmed: false`） | v0 の評判仕様が確定したら |
| `config/rooms.config.json` | room の固有名（`ROOM_NAME_*`）としきい値は仮値。gate 判定は `provisional: true` を返す | 加藤さん確定時。config 差し替えのみ |
| `config/commission.config.json` の `flow` / `escrow.unit` / `arbitration` / `reputation` | 精算単位・レグ・遠隔地の扱い・重み対応はすべて仮値（`confirmed: false`）。委託は `provisional: true` で回る | v0 の commission_flow が確定したら |
| `config/agent.config.json` の `cadence` | tick 頻度・1 回あたり入力トークン・tick あたり呼び出し数はすべて null（未確定） | 加藤さん確定時。埋まるまでゲートが開かない |
| `packages/server/src/agent/dry-run.ts` の `ASSUMED_OUTPUT_TOKENS_PER_CALL` | 出力トークンの想定値 320 は仮値 | 実測（区分B）で置き換える |
| `.env.example` の M3 以降のキー | `NA_WALLET_PRIVATE_KEY` / `NA_X402_FACILITATOR_URL` / `NA_ARCIUM_CLUSTER_URL` / `NA_LLM_API_KEY` はキー名自体が仮 | 各マイルストーン着手時 |

サーバは起動のたびに、未確定の固有名・仮値・後続マイルストーンの env 状態をログに出す。黙って確定扱いにしない。

## 未確定（加藤さん確定待ち）

- `MARKET_NAME` — 市場そのものの名称
- `DISTRICT_NAME` — 地区名
- `NPC_NAME` — NPC の固有名
- `STALL_NAME` — stall の固有名
- `presentation.*` — ビジュアル一式（Donwood のトリートメントに古代モチーフを重ねるか置き換えるかを含む）
- `core_mapping[].presentation_depth` — 史実要素をどこまで演出に使うか
- `economy.commission_flow.*` — commission の具体フロー（レグ数・遠隔地の扱い・精算単位）。実装時に v0 の範囲で詰める

史実地名（ディルムン／マガン／メルッハ／アナトリア／エジプト）は引用可なので確定済みとして `world/world.config.json` に入っている。
