# commission_flow の選択肢（設計のみ・未確定）

`world.config.json` の `economy.commission_flow` と `config/commission.config.json` の `flow` は
**`TBD` / `confirmed: false` のまま**。本書は選択肢を並べるだけで、実装も決め打ちもしない。
加藤さんが選んだら config を差し替え、`confirmed: true` にした時点で実装に入る。

現状の実装は「委託ごとに与えられたレグの数だけを持ち、`provisional: true` で回す」形で、
どの選択肢にも寄せていない。

## 1. legs — レグの単位と数

| 案 | 中身 | escrow / 精算への影響 | 触る実装 |
| --- | --- | --- | --- |
| A. 単一レグ | 委託 = 1 レグ。往復も 1 件として扱う | 精算は 1 回。いちばん単純 | `CommissionBoard.completeLeg` の状態遷移のみ |
| B. 往路 / 復路の 2 レグ固定 | 送り出しと戻りを分ける | 復路失敗時の扱い（前払い分の refund）を決める必要がある | leg の生成規則、`refundForNonDelivery` の粒度 |
| C. 寄港地ごとの可変レグ | 交易相手の数だけレグを持つ（現在の実装の形） | レグ単位精算にするなら escrow を分割する必要がある | escrow の分割、`settle` の呼び出し単位 |
| D. 契約レグ＋実行サブレグの 2 層 | 契約上のレグと、実行時に増える寄港を分ける | 契約は固定、実行は可変。arbitration の対象がどちらかを決める必要がある | 型の追加（`CommissionLeg` の入れ子）、board の状態機械 |

**確定に要る問い**: 委託を出す側は経路を指定するのか、代理人に任せるのか。
途中のレグ失敗は「委託の失敗」か「経路変更」か。

## 2. remote_handling — 遠隔地の扱い

| 案 | 中身 | 市場シムとの関係 | 触る実装 |
| --- | --- | --- | --- |
| A. 名目のみ | `trade_partners` の id を記録するだけ（現在の形） | 影響なし | なし |
| B. 距離と所要 tick | 相手ごとに往復 tick を持ち、納品まで時間がかかる | tick 進行と commission の状態が連動する | `config/market.config.json` に距離、board に時間待ち |
| C. 成功確率とリスク | 相手ごとに失敗率。失敗はショックとして市場にも出る | 供給ショックの発生源が commission 側にも増える | 決定論の乱数系列を board 側にも用意する必要がある |
| D. 現地代理人（サブ代理） | 遠隔地側にも代理人 identity を置き、再委託する | standing が二重に積まれる。再委託の責任分界を決める必要がある | identity の親子関係、評判の配分規則 |

**確定に要る問い**: 遠隔地は「時間」なのか「リスク」なのか、その両方か。
失敗を市場に波及させるか（M1 のショックと繋ぐか）。

## 3. settlement_unit — 精算単位

| 案 | 中身 | x402 レールとの関係 | arbitration への影響 |
| --- | --- | --- | --- |
| A. 委託単位の一括 | 締結時に全額を escrow、完了時に一括 release（現在の形） | 402 の 1 レグに 1 対 1 で対応する | refund は全額か無しの二択 |
| B. レグ単位 | レグごとに部分 release | レグ数だけ 402 が要る。per-call の回数が増える | 部分 refund が要る（現在は未実装） |
| C. 数量 × 単価の従量 | 納品数量に応じて精算 | 金額が実行時まで決まらない。402 の amount 決定が後ろにずれる | 差額の扱いを決める必要がある |
| D. 二段（前払い＋残額） | 着手金と完了時残額 | 402 が 2 回。feePayer は都度取り直す（現在の実装のまま） | どちらの段で争うかで refund 範囲が変わる |

**確定に要る問い**: 単位は USDC の最小単位のままか、世界側の単位を別に置くか
（現在 `escrow.unit` は `TBD` で、金額は最小単位の整数文字列のまま持ち回っている）。
部分 refund を認めるか（認めるなら arbitration の結果に `partial` が要る。現在は `release` / `refund` の二択）。

## 4. どの案でも変えないもの

- 締結は両者合意でのみ確定する。
- release は封印精算の検証（`payment_valid`）が通ってから。検証の中身は受け取らない。
- 完了・不履行・係争の結末は standing（円筒印章の履歴）に積む。
- 金額は最小単位の整数文字列で持ち回り、丸め誤差を作らない。

## 5. 確定したら触る場所

1. `world/world.config.json` の `economy.commission_flow`（`confirmed: true` に）
2. `config/commission.config.json` の `flow` / `escrow.unit` / `arbitration.outcomes`
3. `packages/server/src/commission/board.ts`（状態遷移とレグの生成規則）
4. `packages/server/src/commission/escrow.ts`（分割 release / 部分 refund が要る場合）
5. テスト（`packages/server/src/test/commission.test.ts`）と smoke の一周
