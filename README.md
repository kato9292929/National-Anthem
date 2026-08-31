# National Anthem

## 現状

リポジトリはこのコミット時点で世界設定の確定分のみを持つ。実装コードはまだ入っていない。

| パス | 中身 |
| --- | --- |
| `docs/world-spec-v0.md` | 世界設定スペック v0（正典）。差別化指示書 §3「世界設定と固有名」の確定分 |
| `world/world.config.json` | 上記の機械可読版。固有名・取引カテゴリ・参加者モデル・演出パラメータ |

正典は `docs/world-spec-v0.md`。config と矛盾したらドキュメントが勝つ。

## 実装するときの決まり

- 固有名（市場名・地区名・NPC・stall）はソースにリテラルで書かず、`world/world.config.json` から引く。
- `confirmed: false` は未確定。UI に出す前に確定を取るか、仮値と分かる形で出す。
- 見た目（配色・アセット・レイアウト・UI）は範囲外。`presentation` ブロック（現在すべて `TBD`）にだけ置く。
- ancient world プロジェクトの資産・データ（aw-data）・禁則は流用しない。共有するのは美学のインスピレーションのみ。

## 未確定（加藤さん確定待ち）

- `MARKET_NAME` — 市場そのものの名称
- `DISTRICT_NAME` — 地区名
- `NPC_NAME` — NPC の固有名
- `STALL_NAME` — stall の固有名
- `presentation.*` — ビジュアル一式（Donwood のトリートメントに古代モチーフを重ねるか置き換えるかを含む）
- `core_mapping[].presentation_depth` — 史実要素をどこまで演出に使うか

史実地名（ディルムン／マガン／メルッハ／アナトリア／エジプト）は引用可なので確定済みとして `world/world.config.json` に入っている。
