## 概要

AIニュース提案 X-0086「AIO対策」を、株式会社オージャストの `orgiast.jp` / `rebooth.co.jp` に当てはめた実測監査と改善計画です。

## 実測結果

- 2026-11-19 04:05〜04:10 JST に `curl` で主要8ページ、robots.txt、サイトマップを取得
- 全対象ページはHTTP 200、`https://www.orgiast.jp/llms.txt` は404
- GPTBot / ClaudeBot / PerplexityBot はトップを全てHTTP 200で取得
- orgiast.jp は全対象ページに同じ Organization / FAQPage JSON-LDと同じH1を出力
- Reブース主要4ページはJSON-LD 0件
- 料金ページで「初回100万円から、2回目以降50万円から」、事例で「300万〜500万円」を本文確認

## 追加ファイル

- `docs/ai-news-x0086-aio-orgiast-audit.md`
- `outputs/X-0086/README.md`
- `outputs/X-0086/pr-body.md`

## 含むもの

- HTTPコード・HTML該当箇所に基づくページ別監査表
- 効果×手間で並べた改善計画（対象URL、現状、変更、WordPress作業場所、効果、測定方法）
- `llms.txt` 全文下書き
- Organization / LocalBusiness / Service / FAQPage / 事例JSON-LD下書き
- GA4のAI参照元とAI回答の測定計画
- 未取得事項と理由

## 安全境界

本番反映は kim 承認後です。このPRでは文書だけを追加し、WordPress、サーバー、DNS、GAには一切変更していません。マージは行いません。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
