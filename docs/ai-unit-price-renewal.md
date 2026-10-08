<!-- このファイルは tools/ai-unit-price-renewal.mjs --write が生成する。手で編集しない。 -->
# AI導入後の単価変化と契約更新率（P-0149）

> ⚠️ 社内の案件台帳（受注日・契約金額・契約更新の有無）は本リポジトリにも自動セッションの到達範囲にも存在しない（2026-09-26 実測: tools/ 615ファイル・docs/ を横断検索して該当なし。Drive の読み取り経路は本セッションでは未接続）。したがって本ツールは実データを接続するまで数値を一切出力しない。

- 基準日: 2026-09-26 / 分析窓: 直近 6 ヶ月 / 分割モード: case-flag
- 台帳: 未接続 / 総案件数: 0 / 分析対象: 0（窓外 0 / aiUsed不明 0）

## 分析設計

- 平均単価: 案件ごとの unitPrice = amountYen / quantity を単価基準(unitPriceBasis)ごとに集計する。基準が違う単価を1つの平均に混ぜない。
- 契約更新率: 分母 = renewalTarget が true かつ renewalDueDate が基準日以前（=更新時期が到来済み）の案件。分子 = そのうち renewalRenewed が true の案件。
- 更新時期がまだ来ていない案件（renewalDueDate > asOf）は分母から除外する。除外した件数を必ず出力する。これを分母に入れると更新率が実態より低く出る（打ち切りバイアス）。
- before/after のいずれかで n < minSampleForClaim のときは差分を『参考値』と表示し、reliable=false を付ける。少人数の平均差を効果として断定しない。

## 結果

実データが未接続のため、単価・契約更新率は算出していない（数値は 0 ではなく「なし」）。

## 必要な入力

| フィールド | 型 | 説明 |
|---|---|---|
| id | string | 案件ID（台帳内で一意） |
| name | string | 案件名 |
| contractDate | YYYY-MM-DD | 契約日（分析期間の判定に使う） |
| amountYen | number | 契約金額（円） |
| quantity | number | 単価の分母。件あたりなら 1、人日単価なら人日数、月額なら月数 |
| unitPriceBasis | case\|person-day\|month | 単価の基準 |
| aiUsed | boolean\|null | この案件でAIを活用したか。splitMode=case-flag のとき必須。null は unknown |
| renewalTarget | boolean | 契約更新の対象案件か |
| renewalDueDate | YYYY-MM-DD\|null | 更新時期。到来前は更新率の分母から外す |
| renewalRenewed | boolean\|null | 実際に更新されたか |

- 実データが未接続です。単価・契約更新率は算出結果として表示しません。

## 限界

- 本ツールは集計と検定前の記述統計まで。因果（AI導入が単価を上げた）は言えない。相関と交絡の切り分けは別途。
- 更新率の比較は before/after で契約期間の分布が揃っていることを前提にする。揃っていない場合は比較せず、その旨を出力する。

## データの接続方法

- 台帳 JSON: tools/ai-unit-price-renewal-cases.json の cases に追記し、dataStatus を "connected" にする
- CSV: `node tools/ai-unit-price-renewal.mjs --analyze <file>.csv`
- 雛形: `node tools/ai-unit-price-renewal.mjs --template`
