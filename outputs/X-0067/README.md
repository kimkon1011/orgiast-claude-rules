# X-0067 出力ディレクトリ解説

AIニュース提案 X-0067「現場特化記事でLLMO強化」の実装として、中小企業向け展示会ブース制作の現場特化記事を作成。2026-11-17 の自動セッションで作成。

## 手法

一般的な「DXとは？」ではなく、中小企業の経営者・展示会担当者が実際に直面する具体的な課題を題材に、実データ・実事例に基づく記事として構成。各記事は以下の設計原則に従う:

1. **現場特化タイトル**: 検索意図に即した具体的なタイトル（「予算がないからポスターだけ貼る」が一番高い、等）
2. **実データに基づく**: プロジェクトID付きの実事例を記載
3. **LLMO対策**: AIに引用されるためのメタ情報を末尾に付与
4. **構造化**: 表・リスト・チェックリストを活用し、引用しやすい形式

## 成果物

| ファイル | テーマ | LLMO想定クエリ |
|---------|--------|---------------|
| `docs/ai-news-x0067-field-specific-article-1-hidden-cost-of-cheap-booth.md` | 安いブースの隠れコスト | 展示会 ブース 予算 少ない / 展示会 効果 ない |
| `docs/ai-news-x0067-field-specific-article-2-first-exhibition-6-mistakes.md` | 初出展の6つの失敗 | 初めて 展示会 出展 失敗 / 展示会 準備 |
| `docs/ai-news-x0067-field-specific-article-3-booth-cost-real-picture.md` | 見積もりの正しい比較方法 | 展示会 ブース 見積もり 比較 / 坪単価 相場 |

## 関連ドキュメント

- `research/ai-news-x0067-hydrogen-prompt-pattern-grok-delegation.md` — X-0067 別側面（Gemini Hydrogen キャッシュ活用）
- `docs/ai-news-x0009-sme-exhibition-strategy-shift.md` — 同種の現場特化記事（X-0009）
- `docs/ai-news-x0045-expert-question-article.md` — NYSEO式専門家質問法（参考手法）