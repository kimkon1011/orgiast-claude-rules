# GPT-6 Astra / GPT-5.6 Sol コスト比較

> 価格は 2026-09-20 時点。一次出典: https://developers.openai.com/api/docs/pricing。GPT-5.6 Sol はプロモ価格（〜2026-11-21）。
> このファイルは生成物。手で編集しない。再生成: `node tools/astra-sol-cost-plan.mjs`

## 結論

**同じトークン量なら、全5シナリオで GPT-5.6 Sol が最安。** Astra は全カテゴリで Sol の2.5倍なので、価格だけで選ぶ最適プランは各シナリオの許容ティア × Sol。

| シナリオ | 許容最安ティア | Astra/月 | Sol/月 | Astra/Sol | price-only winner |
|---|---:|---:|---:|---:|---|
| nightly-batch | batch | $2,250.00 | $900.00 | 2.50x | gpt-5.6-sol |
| coding-agent | standard | $3,288.00 | $1,315.20 | 2.50x | gpt-5.6-sol |
| chat-assistant | standard | $1,470.00 | $588.00 | 2.50x | gpt-5.6-sol |
| doc-summarize | flex | $6,875.00 | $2,750.00 | 2.50x | gpt-5.6-sol |
| realtime-quick | standard | $615.00 | $246.00 | 2.50x | gpt-5.6-sol |

## シナリオ別判定

### nightly-batch — 夜間バッチ分類・整形

- 最適プラン: **GPT-5.6 Sol × batch**（$900.00/月）
- Astra: $2,250.00/月、Sol比 2.50x。
- 69%削減仮定のAstra参考値: $697.50/月、Sol比 0.775x — **unverified-secondary**。

### coding-agent — 実装エージェント

- 最適プラン: **GPT-5.6 Sol × standard**（$1,315.20/月）
- Astra: $3,288.00/月、Sol比 2.50x。
- 69%削減仮定のAstra参考値: $1,019.28/月、Sol比 0.775x — **unverified-secondary**。

### chat-assistant — 定常チャット

- 最適プラン: **GPT-5.6 Sol × standard**（$588.00/月）
- Astra: $1,470.00/月、Sol比 2.50x。
- 69%削減仮定のAstra参考値: $455.70/月、Sol比 0.775x — **unverified-secondary**。

### doc-summarize — 長文ドキュメント要約

- 最適プラン: **GPT-5.6 Sol × flex**（$2,750.00/月）
- Astra: $6,875.00/月、Sol比 2.50x。
- 69%削減仮定のAstra参考値: $2,131.25/月、Sol比 0.775x — **unverified-secondary**。

### realtime-quick — 即時短命応答

- 最適プラン: **GPT-5.6 Sol × standard**（$246.00/月）
- Astra: $615.00/月、Sol比 2.50x。
- 69%削減仮定のAstra参考値: $190.65/月、Sol比 0.775x — **unverified-secondary**。

## ブレークイーブン

価格比 2.5x では、Astraの消費トークンが Sol の **40%未満**ならAstraが安い（40%ちょうどは同額）。
二次報道の「69%減」を仮定すると消費量は31%で、価格比込みの費用はSol比 0.775x。ただし、この効率主張は **unverified-secondary** であり、購入判断の確定値には使わない。

## ティア制約と注記

- batch: 夜間バッチなど遅延を許容できる処理だけに使用。
- flex: 遅延・中断を許容できる処理だけに使用。
- standard: 即時性や安定した実行を要する残りのシナリオに使用。
- fast: standard の2倍。最安比較から除外。
- リージョナル処理は 10% 上乗せ。本表には未加算。
- cache writes 単価はカタログに保持するが、今回の5シナリオでは使用しない。

## 検証状況

- 価格・ティア: **verified-primary** — https://developers.openai.com/api/docs/pricing
- 69%トークン効率: **unverified-secondary** — tech.ifeng.com（二次報道・2026-09 検索経由）
- コンテキスト窓: **unverified-secondary**（本計算には不使用）

## 出典

- https://developers.openai.com/api/docs/pricing

