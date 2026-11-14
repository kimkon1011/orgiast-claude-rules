# X-0032 出力ディレクトリ解説

AIニュース提案 X-0032「Grok Bot連携でバックオフィス経費削減」の設計書と実装レポートを置く場所です。2026-11-14 の自動セッションで作成。

## ディレクトリ構造

```
outputs/X-0032/
└── README.md                         # 本解説
```

## 設計書

| ファイル | 説明 |
|---|---|
| `docs/ai-news-x0032-grok-backoffice.md` | 設計文書（4領域のアーキテクチャ・5 Phase実装計画） |
| `docs/ai-news-x0032-ai-seo-agent.md` | 元のX-0032提案（AI SEOエージェント版） |

## 関連ツール

| ツール | 説明 |
|---|---|
| `tools/grok-ask.mjs` | Grok API CLI問合せ |
| `tools/grok-bot-prompt-bridge.mjs` | Grokリサーチ→Claude Code実装変換 |
| `tools/grok-x-fetch.mjs` | X/Twitter投稿取得 |
| `tools/grok-monitor-cost-model.mjs` | 監視頻度最適化モデル |
| `tools/freee-query.mjs` | freee会計読取CLI |
| `tools/line-channel.mjs` | LINE送受信CLI |

## 残り

- [ ] Grok SuperGrok（$30/月）契約の確認・提案
- [ ] Grok Bot Routine/Scout機能の実機検証
- [ ] `tools/grok-freee-bridge.mjs` の実装（Phase 1）
- [ ] LINE→Grok Webhookブリッジの設計・実装（Phase 3）
- [ ] 各Phaseの検証

---

## 2026-11-14 初回作成

X-0032のバックオフィス版設計書を作成。既存のX-0032（AI SEOエージェント版）とは別トラックとして並行推進可能。

### 作成したもの

| ファイル | 説明 |
|---|---|
| `docs/ai-news-x0032-grok-backoffice.md` | 4領域（会計・スカウト・資料作成・問い合わせ）×5 Phaseの設計書 |
| `outputs/X-0032/README.md` | 本解説 |

### 現状の判断

- **Grok SuperGrok契約が最初のゲート**: $30/月でRoutine・Scout・Emailトリガーが使えるようになる。契約なしだとGrok API（従量）のみでBot機能は使えない。
- **freee MCPの可用性確認が必要**: 2026年10月以降公開中だが、実運用レベルかは検証必須。
- **既存ツールで即座に始められるもの**: Grok API + `freee-query.mjs` でfreeeデータの自然言語問合せ（例: 「今月の売上は？」とGrokに聞く）は既存の `grok-ask.mjs` + `freee-query.mjs` で可能。
