# X-0011: SEOとAEOの11の再現可能手法 — PHASE2

## 変更内容

### 新規ファイル
- `docs/ai-news-x0011-seo-aeo-11-methods.md` — 11手法の包括的実装計画・優先度・既存成果統合
- `tools/reddit-monitor.mjs` — Reddit監視ツール（手法1+3）: 展示会ブース関連投稿を検出しブログ記事案を生成
- `tools/ai-mention-checker.mjs` — AI回答言及チェッカー（手法9）: ChatGPT/Claude/Gemini等での自社言及を月次確認
- `tools/reddit-monitor.test.mjs` — Reddit監視ツールのテスト（4ケース）
- `tools/ai-mention-checker.test.mjs` — AI言及チェッカーのテスト（5ケース）
- `outputs/X-0011/pr-body.md` — 本PRの本文

### 既存PRとの統合
本PRは以下の既存X-0011成果を統合するPHASE2:
- PR #1739: GSCキーワード検出器＋日次SEOガイド生成ワークフロー
- PR #1747: 信頼度ベース分類器
- PR #1779: イベントページ再現
- PR #1836: 4エージェント学習ループ

### 11手法の実装状況
| # | 手法 | 状態 |
|---|------|------|
| 1 | Redditスレッドに登場させる | ✅ 新規 `tools/reddit-monitor.mjs` |
| 2 | 既存リストicleで#1掲載 | ⏳ 未着手（比較表ページ） |
| 3 | Reddit質問をブログ記事化 | ✅ 新規 `tools/reddit-monitor.mjs` |
| 4 | 新ニッチ研究と記事化 | ✅ PR #1739 `tools/gsc-keyword-finder.mjs` |
| 5 | 毎日SEO記事公開 | ✅ PR #1739 `tools/daily-seo-guide.mjs` |
| 6 | 古い記事定期更新 | ⏳ 未着手 |
| 7 | 毎週バックリンク | ⏳ 未着手 |
| 8 | 有用無料ツール公開 | ✅ PR #1747 `tools/confidence-classifier.mjs` |
| 9 | 毎月AI回答言及チェック | ✅ 新規 `tools/ai-mention-checker.mjs` |
| 10 | ユーザーレビュー奨励 | ⏳ 未着手 |
| 11 | アフィリエイト化 | ⏳ 未着手 |

### オージャスト適用手順
1. **毎朝**: `node tools/reddit-monitor.mjs --cron --state-file data/reddit-state.json` → ブログ記事案を確認
2. **毎朝**: `node tools/daily-seo-guide.mjs --keyword "選定KW" --publish-draft` → SEO記事をWordPress下書き保存
3. **毎月**: `node tools/ai-mention-checker.mjs --monthly` → AI検索での自社言及を確認
4. **週次**: GSCキーワード分析 → `node tools/gsc-keyword-finder.mjs` → 展示会関連KWを優先

## 検証結果
- ✅ 新規テスト 9/9 pass
- ✅ 既存X-0011テスト 11/11 pass（confidence-classifier）
- ✅ 各ツールのCLI引数パース正常動作確認
- ✅ キーワードマッチングの日英対応確認
- ✅ AI言及検出パターンの正常動作確認（オージャスト/orgiast/誤表記）

## 残タスク（次セッション）
- [ ] P2: 比較表ページ制作（手法2: 既存リストicleで#1掲載）
- [ ] P2: 記事更新ツール `tools/article-updater.mjs`（手法6: 古い記事定期更新）
- [ ] P2: バックリンク候補リスト（手法7: 毎週バックリンク）
- [ ] P3: Googleレビュー依頼ワークフロー（手法10）
- [ ] P3: アフィリエイトプログラム設計（手法11）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
