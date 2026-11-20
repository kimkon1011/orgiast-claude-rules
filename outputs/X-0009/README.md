# X-0009: AI引用ソースのブランド言及分析 — 全体インデックス

> AIニュース提案 [X-0009]: 商業的質問から始め、AIシステムが実際に引用するソースを調査。競合が言及され自社が欠けているページを特定。自社コンテンツと第三者言及を構築する。

## 成果物一覧

| ファイル | 内容 | 状態 |
|---------|------|------|
| `tools/brand-mention-analyzer.mjs` | AI引用ブランド言及分析CLIツール | 実装中 |
| `tools/brand-mention-analyzer.test.mjs` | テストスイート | 実装中 |
| `docs/ai-news-x0009-brand-mention-analyzer.md` | ブランド言及分析ツール設計書 | 設計完了 |
| `docs/ai-news-x0009-case-study-precision-machinery.md` | 事例記事: 精密加工メーカー成約率35%向上 | 公開済み (#1753) |
| `docs/ai-news-x0009-sme-booth-design-5-principles.md` | 事例記事: 中小企業ブース設計5原則 | 公開済み (#1753) |
| `docs/ai-news-x0009-sme-exhibition-strategy-shift.md` | 事例記事: 中小企業の展示会戦略転換 | 公開済み (#1753) |
| `docs/ai-news-x0009-kv-cache-prefix-sharing.md` | KVキャッシュプレフィックス共有設計書 | 実装済み |
| `tools/kv-cache-prefix-gateway.mjs` | KVキャッシュプレフィックス共有ゲートウェイ | 実装済み (18 tests) |
| `tools/kv-cache-prefix-gateway.test.mjs` | テストスイート (全18テスト) | 実装済み |
| `outputs/X-0009/cache-efficiency-report.md` | キャッシュ効率レポート | 実装済み |
| `docs/ai-news-x0009-exhibitor-ai-sales-targeting.md` | 展示会出展リストからのAI営業ターゲット抽出ランブック | 設計完了 |
| `docs/ai-news-x0009-seo-workflow-agent-9steps.md` | SEOワークフローAIエージェント化9ステップ（X-0007統合） | 設計完了 |

## LLMO記事（現場専門性コンテンツ #1753）

AI引用を獲得するために作成した業界特化型記事:

- [精密加工メーカー成約率35%向上事例](ai-news-x0009-case-study-precision-machinery.md)
- [中小企業ブース設計5原則](ai-news-x0009-sme-booth-design-5-principles.md)  
- [中小企業の展示会戦略転換](ai-news-x0009-sme-exhibition-strategy-shift.md)

各記事は「AI引用のためのメタ情報」セクションを含み、AIが回答に引用しやすい構造を採用。

## ブランド言及分析ツール（今回）

`tools/brand-mention-analyzer.mjs` — 商業的質問を複数の安価AIに送信し、回答中のブランド言及を抽出・比較する。

```bash
# 展示会ブース制作の質問で各AIの言及をチェック
node tools/brand-mention-analyzer.mjs \
  --question "展示会ブース制作 おすすめの会社は？" \
  --competitors "リブース,クラフト,ブーステック"
```

設計詳細: `docs/ai-news-x0009-brand-mention-analyzer.md`

## 残TODO

- [x] 設計書作成
- [ ] ブランド言及分析ツール実装 (tools/brand-mention-analyzer.mjs)
- [ ] テスト実装 (tools/brand-mention-analyzer.test.mjs)
- [ ] 実データ（オージャスト関連キーワード）での分析レポート
- [ ] PR作成・マージ
- [ ] AI引用のベンチマーク（現在の引用数）測定