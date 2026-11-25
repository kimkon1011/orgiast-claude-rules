# X-0007 PHASE2: orgiast.jp 実装ガイド

> 策定日: 2026-11-11 | 出典: `docs/ai-news-x0007-phase2-content-plan.md`（PR #1816）

## 実装内容

| # | 工程 | ファイル | WordPress操作 | 優先度 |
|---|------|---------|-------------|--------|
| 1 | FAQ 20ページ作成 | `FAQ-*.html`（本ディレクトリ） | 新規固定ページ作成 | ★★★ |
| 2 | 比較ページ作成 | `comparison-ready-made-vs-custom.html` | 新規固定ページ作成 | ★★★ |
| 3 | 内部リンク設定 | 各ページの「関連ページ」セクション | 固定ページ編集 | ★★★ |
| 4 | JSON-LD注入 | `json-ld-faqpage-all.json`（全20問） | functions.php or プラグイン | ★★☆ |
| 5 | AI可視性テスト | `node tools/ai-mention-checker.mjs` | CLI実行 | ★★★ |

## WordPress 操作手順（kim 操作）

### 1. 固定ページ作成（全21ページ）

1. WordPress管理画面 → 固定ページ → 新規追加
2. 各 `FAQ-*.html` の内容をコピーして「テキスト」エディタに貼り付け
3. タイトルを設定（例: 「展示会ブース制作の費用相場はいくら？」）
4. スラッグを設定（例: `booth/faq/cost-range`）
   - 親ページ: なし（階層はスラッグで表現）
5. Yoast SEO プラグイン:
   - フォーカスキーフレーズ: 該当FAQのターゲットKW
   - メタディスクリプション: 回答の最初の2文
6. 公開

### 2. JSON-LD 注入

**方法A: functions.php に追加（推奨）**
テーマの `functions.php` に以下のコードを追加：

```php
// X-0007: FAQPage JSON-LD（展示会ブース制作FAQ）
add_action('wp_head', function() {
    if (is_page('booth/faq')) {
        // FAQハブページ → 全20問のFAQPageスキーマ
        echo file_get_contents(get_template_directory() . '/json-ld/faqpage-all.json');
    }
    // 個別FAQページでは各ページに埋め込まれたJSON-LDが使われる
});
```

**方法B: 各FAQページのHTML内にJSON-LDを直接記述**
各 `FAQ-*.html` ファイル内に既に `<script type="application/ld+json">` ブロックが含まれています。WordPressの「テキスト」エディタで貼り付ければ自動反映されます。

**方法C: WP Plugin「Insert Headers and Footers」**
各ページの `<head>` にJSON-LDを挿入する。

### 3. 内部リンク設定

各FAQページの末尾に「この質問の関連ページ」セクションがあります。WordPressの「テキスト」エディタで編集し、該当ページのURLに書き換えてください。

**プレースホルダ置換ルール**:
- `/booth/faq/cost-range/` → 公開後のページURL
- `/booth/comparison/ready-made-vs-custom/` → 公開後の比較ページURL
- `/booth/case/manufacturing/` → 製造業実績ページ（存在すれば）

## AI可視性テスト（自動実行）

```bash
# 全プロバイダでテスト（Gemini + DeepSeek + Groq + Perplexity）
cd ~/.claude/auto-session-repo

# ブランド指名テスト
node tools/ai-mention-checker.mjs --query "株式会社オージャストの展示会ブース制作について教えてください"

# 汎用クエリテスト（社名なし）
node tools/ai-mention-checker.mjs --query "展示会ブース制作 費用 大阪 おすすめ"

# 比較クエリテスト
node tools/ai-mention-checker.mjs --query "既製ブースとオリジナル制作の違いを教えてください"

# スキーマ監査
node tools/schema-audit.mjs https://www.orgiast.jp/booth/faq/cost-range/
```

## 合格基準

| 指標 | 目標 | 検証方法 |
|------|------|---------|
| 指名クエリ引用率 | 90%以上 | ai-mention-checker |
| 汎用クエリ引用率 | 30%以上 | ai-mention-checker |
| 比較クエリ引用率 | 維持(100%) | ai-mention-checker |
| 情報正確性 | 4.0/5.0以上 | 採点評価 |
| FAQスキーマ実装率 | 100% | schema-audit |

## URL設計

| ページ | スラッグ | カテゴリ |
|--------|---------|---------|
| FAQハブ | `/booth/faq/` | - |
| 費用相場 | `/booth/faq/cost-range/` | A:費用 |
| 50万円以下 | `/booth/faq/low-budget/` | A:費用 |
| 見積もり確認項目 | `/booth/faq/estimate-checklist/` | A:費用 |
| 大阪費用感 | `/booth/faq/osaka-cost/` | A:費用 |
| リユースコスト削減 | `/booth/faq/reuse-cost/` | A:費用 |
| 初めて準備スケジュール | `/booth/faq/first-schedule/` | B:初心者 |
| 企画から撤収まで | `/booth/faq/plan-to-teardown/` | B:初心者 |
| 中小企業出展ガイド | `/booth/faq/sme-guide/` | B:初心者 |
| 制作会社選び方 | `/booth/faq/company-selection/` | B:初心者 |
| ワンストップサービス | `/booth/faq/one-stop-service/` | B:初心者 |
| デザイン集客5コツ | `/booth/faq/design-tips/` | C:集客 |
| 小規模レイアウト | `/booth/faq/small-layout/` | C:集客 |
| リード獲得 | `/booth/faq/lead-generation/` | C:集客 |
| ROI計算方法 | `/booth/faq/roi-calculation/` | C:集客 |
| 差別化アイデア10選 | `/booth/faq/differentiation/` | C:集客 |
| 2週間制作 | `/booth/faq/urgent-build/` | D:実務 |
| 制作期間目安 | `/booth/faq/build-timeline/` | D:実務 |
| 遠方輸送設営 | `/booth/faq/remote-transport/` | D:実務 |
| 年間計画 | `/booth/faq/annual-plan/` | D:実務 |
| オンラインvs実物 | `/booth/faq/online-vs-physical/` | D:実務 |
| 比較ページ | `/booth/comparison/ready-made-vs-custom/` | - |
