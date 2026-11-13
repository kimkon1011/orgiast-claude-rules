# X-0013: 既存ランキングページのAI補完SEO

**AIニュース提案 X-0013**: GSCデータを使い、既存ページの表示回数があるがコンテンツにないクエリと10-30位のクエリを特定し、ページの一部分だけをAIエージェントが補完するSEO施策。

## 現状（2026-11-09）

### ✅ 完了
1. **キーワードリサーチエージェント**（`skills/booth-kw-research/`）: 全4Phase実装済み
   - Phase 1: 自社・競合サイトクロール
   - Phase 2: キーワード発掘・収集・統合
   - Phase 3: LLM分類 + 優先順位付け（スコア計算）
   - Phase 4: コンテンツギャップ分析 + 最適化提案
   - テスト10件 PASS
   - 調整パラメータ設定済み（crawl深度3、類似度0.8、温度0.1）
   - 監視・改善指標定義済み

2. **SEOコンテンツ補完ツール**（`tools/seo-content-complement.mjs`）: 新規実装
   - GSC CSV 解析（表示ありクエリ・10-30位クエリの特定）
   - コンテンツ構造分析（冒頭長・H2数・FAQ有無）
   - 補完タイプ自動決定（intro_rewrite / new_h2 / faq_section / inline_paragraph / new_page / internal_link）
   - 内部リンク候補生成
   - JSON + Markdown レポート出力
   - テスト6件 PASS

3. **成果物**
   - `outputs/X-0013/README.md` — ツール説明書
   - `outputs/X-0013/seo-complement-plan.json` — 補完計画（JSON）
   - `outputs/X-0013/seo-complement-plan.md` — 補完計画（Markdown）

### 🔄 残作業（ビジネス判断待ち）
1. **GSC実データ取得**: Google Search Console API の OAuth トークン設定（X-0011 と同条件）
2. **WordPress編集**: 実際のページ内容を確認し、補完提案に従って編集（手動）
3. **GSC再インデックス申請**: 編集後にGoogle Search Consoleでインデックス登録をリクエスト
4. **効果測定**: 7-14日後に表示回数・クリック率の変化を確認
5. **サイクル実行**: 1-3ヶ月ごとにキーワードリサーチ→補完→測定を繰り返す

### 実装詳細

**booth-kw-research** は2026-11-08に計8イテレーションで実装:
- iter1-4: Phase 1-4 基本実装 + dry-run
- iter5: phase1-4 に dry-run と recommended_action 追加、テスト追加（cheap-code/deepseek 実装、9/9 PASS）
- iter6: Step8 調整パラメータ設定（adjustment-params.json）
- iter7: Step9 監視・改善指標の定義（SKILL.md に追記）

**seo-content-complement** は2026-11-09に実装:
- GSCデータ分析機能
- コンテンツ構造ヒューリスティック分析
- 補完タイプ決定ロジック（意図ベース + GSCデータ + 構造分析）
- 内部リンク候補生成
- JSON + Markdown デュアル出力
- テスト6件 PASS

### 関連
- X-0011: 信頼度ベース分類器（GSC API アクセス基盤）
- X-0009: SEOワークフローをAIエージェント化する9ステップ
- booth-kw-research skill
