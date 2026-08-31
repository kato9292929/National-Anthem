# National Anthem

## 現状

世界設定の確定分と、M0（scaffold）／M1（サーバ権威の市場シム）／M2（歩けるグレイボックス）の実装が入っている。

| パス | 中身 |
| --- | --- |
| `packages/shared` | 型・world config ローダ・命名解決・シード付き乱数。サーバとクライアントの契約 |
| `packages/server` | 市場シム（サーバ権威・決定論）と HTTP API |
| `packages/client` | WebGL 一人称クライアント。グレイボックスの市場空間と HUD |
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
npm run smoke             # Chromium で M2 の受け入れを確認し artifacts/ に画面を残す

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

### マイルストーンの状態

| M | 中身 | 状態 |
| --- | --- | --- |
| M0 | scaffold（パッケージ構成・config ローダ・env の枠・ラベル運用） | 済 |
| M1 | サーバ権威の市場シム（決済もLLMも無し） | 済 |
| M2 | 歩けるグレイボックス・クライアント | 済 |
| M3 以降 | identity/wallet、x402 決済、Arcium、エージェント自律、commission board | 別指示待ち |

M0〜M2 は LLM も決済も呼ばない。課金要素ゼロ。

## 実装するときの決まり

- 固有名（市場名・地区名・NPC・stall）はソースにリテラルで書かず、`world/world.config.json` から引く。
- `confirmed: false` は未確定。UI に出す前に確定を取るか、仮値と分かる形で出す。
- 見た目（配色・アセット・レイアウト・UI）は範囲外。`presentation` ブロック（現在すべて `TBD`）にだけ置く。
  クライアント側のグレイボックスの値は `packages/client/src/greybox.ts` の 1 ファイルにまとめ、ロジックへ散らさない。
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
