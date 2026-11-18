# X-0072: Gemini強化に合わせた派生FAQページ追加

## 変更内容

主要20FAQの「次に聞かれる質問」を体系的に洗い出し、以下の5件の派生FAQページを新規作成しました。

### 追加したページ

| # | スラッグ | タイトル | 派生元 | カテゴリ |
|---|---------|---------|--------|---------|
| 21 | `/booth/faq/material-cost/` | ブース制作の素材別費用比較【木工・金属・アクリル】 | Q1, Q3 | 費用・予算 |
| 22 | `/booth/faq/hidden-cost/` | 展示会出展の隠れ費用と予算に組み込むべき全項目 | Q3, Q4 | 費用・予算 |
| 23 | `/booth/faq/staff-training/` | 展示会ブースのスタッフ教育と当日運営完全ガイド | Q6, Q8 | 初心者ガイド |
| 24 | `/booth/faq/lead-followup/` | 展示会出展後のリードフォローアップ完全ガイド | Q13, Q14 | 集客・効果 |
| 25 | `/booth/faq/low-budget-differentiation/` | 低予算で他社と差をつけるブース演出アイデア | Q12, Q15 | 集客・効果 |

### 選定基準
- AI引用されやすさ（具体的な数値・手順・表を含む）
- ギャップの大きさ（既存コンテンツで未カバー）
- X-0035 Topical Authority分析での未カバーサブトピックとの一致

### フォーマット
既存FAQページ（`FAQ-ALL-20-QUESTIONS.html`）と同じフォーマットに準拠:
- WordPress固定ページ用HTML
- FAQPage JSON-LDスキーマ
- 具体的な数値・事例を含む回答
- 関連ページへの内部リンク

### 派生元分析
`docs/ai-news-x0072-derivative-coverage-plan.md` に全20FAQからの派生論点マトリックスを掲載。

🤖 Generated with [Claude Code](https://claude.com/claude-code)