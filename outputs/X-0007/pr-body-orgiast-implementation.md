## X-0007 PHASE2: orgiast.jp 実装パッケージ

AI検索向けサイトコンテンツ最適化（PR #1816 でPHASE2計画完了）の残作業「orgiast.jpへの実装」のためのWordPress貼付用コンテンツパッケージ。

### 成果物

| ファイル | 内容 | 用途 |
|---------|------|------|
| `FAQ-ALL-20-QUESTIONS.html` | 全20問FAQ（4カテゴリ）× 回答＋実例＋JSON-LD | WordPress固定ページに貼り付け |
| `comparison-ready-made-vs-custom.html` | 既製vsオリジナル比較ページ（比較表＋事例＋ItemListスキーマ） | WordPress固定ページに貼り付け |
| `json-ld-faqpage-all-20.json` | 全20問のFAQPageスキーマ（FAQハブページ用） | functions.phpから読み込み |
| `IMPLEMENTATION-GUIDE.md` | WordPress操作手順＋URL設計＋AI可視性テスト手順 | kim操作のガイド |

### AI可視性ベースライン（2026-11-10）

| クエリ種別 | 結果 | PHASE2目標 |
|-----------|------|-----------|
| 指名クエリ（社名あり） | 100% ✅ | 90%以上 |
| 汎用クエリ（社名なし） | 0% ⚠ | 30%以上 |

### 残（kim操作が必要）

1. WordPress管理画面で全21ページ（FAQ20＋比較1）を固定ページとして作成
2. JSON-LDを functions.php または各ページに注入
3. 内部リンクのプレースホルダを実URLに置換
4. 公開後に AI可視性テストを再実行

### 関連PR

- #1816 — PHASE2 コンテンツ最適化計画（設計書）
- #1761 — PHASE1 AI可視性監査

🤖 Generated with [Claude Code](https://claude.com/claude-code)
