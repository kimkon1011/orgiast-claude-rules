## X-0007 PHASE2: クロール性・スキーマ実装 + PHASE1 A スコアリング

### 内容

**PHASE1 A スコアリング更新:**
- `ai-visibility/score-20261108-15.md`: 30/105 プロンプトのスコアリング結果（引用率83.3%）
  - 指名クエリ: 75%引用 / 比較クエリ: 100%引用 / 会社名なし汎用: 0%引用
  - LLM幻覚問題（所在地・設立年が毎回異なる）を確認
- gate-summary: PHASE1 A 部分完了、残75プロンプトは次セッション

**PHASE2 スキーマ実装仕様:**
- `ai-visibility/phase2-schema-spec.md`: 優先度別スキーマ実装仕様
  - P0: Organization / LocalBusiness / FAQPage
  - P1: Article / HowTo / Project
  - P2: BreadcrumbList
  - 推奨FAQ20問リスト

**スキーマ監査ツール:**
- `tools/schema-audit.mjs`: orgiast.jp のJSON-LD構造化データを抽出・検証
- `tools/schema-audit.test.mjs`: 13 tests ✅
- 実サイト監査結果: Organization/WebSite/FAQPage は実装済み、logo/potentialAction/Article/HowTo が不足

### 検証
- schema-audit.test.mjs: 13 tests pass
- 実サイト監査: orgiast.jp に3件のJSON-LD確認（Organization/WebSite/FAQPage）
- rebooth.co.jp 監査: 未実施（次回）

### 残課題
- PR #1689 (PHASE1 B) CI通過・マージ待ち（distribution-manifest 修正済み、CI再実行中）
- PHASE1 A 残75プロンプトの実行
- rebooth.co.jp / event-shop.jp のスキーマ監査
- 実際のスキーマ実装デプロイ（別リポジトリ）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
