# X-0013 評価追補: Impeccable + Claude-SEO ツール評価

**発行日**: 2026-11-10
**対象サイト**: `apps/expo-apply/`（海外企業向け展示会出展受付サイト）

**既存のX-0013作業**: SEOコンテンツ補完ツール（`tools/seo-content-complement.mjs`）+ `skills/booth-kw-research/` は完了済み。本稿は別アプローチとして、GitHub急上昇AIリポジトリ2種を評価する。

---

## 1. 評価サマリ

| ツール | 評価 | 既存X-0013との関係 | 推奨 |
|--------|------|-------------------|------|
| **Impeccable** (`pbakaus/impeccable`, 106K⭐) | **導入価値あり**（設計語彙・スロップ検出器） | 補完的。UI品質ゲートとして独立 | 開発フローに組み込む |
| **Claude-SEO** (`AgriciDaniel/claude-seo`, 27K⭐) | **参考価値あり**（ベンチマーク比較用） | 代替的。既存ツールより包括的だが重い | 既存との比較検証のみ |

---

## 2. Impeccable 評価

### 概要
https://github.com/pbakaus/impeccable

AIコーディングエージェント向け「デザイン語彙」システム。24コマンドでデザインの方向性制御（bolder/quieter/distill/colorize等）・レビュー（critique/audit）・スロップ検出（62ルール）を提供。

### expo-applyサイトへの実際のスキャン結果

`npx impeccable detect apps/expo-apply/` 実行（静的ディレクトリ）:

| 発見項目 | ファイル | 重要度 | 内容 |
|----------|---------|--------|------|
| flat-type-hierarchy | `faq.html`, `research.html` | warning | heading 16px = body 16px（最低1.25倍必要） |
| low-contrast | `index.html` hero | warning | 3.3:1（WCAG AA 4.5:1不足） #ebf3fe on #3b82f6 |
| low-contrast | `index.html` 補足 | advisory | 4.3:1 #64748b on #f1f5f9（+6箇所） |
| skipped-heading | `index.html` | warning | h1直後にh3（h2スキップ） |

### 評価: 導入価値あり

1. **静的スキャンが有用**: Node.jsのnpmパッケージとして即実行可能。62ルールのスロップ検出器はCIに組み込める。
2. **設計語彙として**: expo-applyサイトはシンプルなLP形式だが、展示会ブース制作サイト（tetsuko.co.jpやorgiast.jp）の本番ページへのcritique/auditがより効果的。
3. **課題**: フックとして常駐させるには各エージェントへの設定が必要。

### 推奨導入方法
```bash
cd apps/expo-apply
npx impeccable install --providers=claude --scope=project
# またはCIだけで使う場合
npx impeccable detect src/ --github
```

---

## 3. Claude-SEO 評価

### 概要
https://github.com/AgriciDaniel/claude-seo

Claude Code用SEOスキル。26サブスキル + 19専門エージェント。テクニカルSEO・コンテンツ品質・構造化データ・GEO/AEO・ローカルSEO・EC・国際SEOをカバー。

### 既存X-0013との比較

| 観点 | 既存X-0013 (`seo-content-complement.mjs`) | Claude-SEO |
|------|------------------------------------------|------------|
| 範囲 | GSCギャップ発見＋補完提案のみ | 包括的SEO監査（技術/コンテンツ/スキーマ/被リンク等） |
| エージェント数 | 1ツール | 19エージェント + 30コマンド |
| 実行時間 | 数秒 | 10-15分/回 |
| GSC連携 | CSV入力 | Google API統合（OAuth設定必要） |
| GEO/AEO | 未対応 | 対応（AI Overviews, ChatGPT, Perplexity引用判定） |
| 外部費用 | 無料 | Claude Codeサブスクリプションが必要（Opus/Sonnet呼出で費用増） |
| オフライン | ✅ 完全オフライン | 一部拡張にAPI Key必要 |

### 評価: 参考価値あり（導入判断は慎重に）

1. **包括的SEO監査として**: 既存のX-0013ツールよりも広範囲をカバーするが、Claude Codeのトークン消費が大きい（19エージェント並列で10-15分）。
2. **GEO/AEO対応**: AI検索（ChatGPT, Perplexity, Gemini）での引用判定は既存ツールにない機能だが、当サイト（B2B受付フォーム）では優先度低。
3. **リソース負荷**: 定期的（週次）監査には不向き。Claude Codeが動く環境が必要。

### 推奨
- **導入より比較参考**: 既存のX-0013ツールの機能拡張（GEO/AEO判定等）の参考としてコードを参照。
- **代替**: 軽量版としてSEOスキャンが必要ならPageSpeed Insights APIやLighthouse単体を使う。

---

## 4. 結論と提言

### X-0013の現状位置づけ

X-0013は**既存ランキングページのAI補完SEO**として完了済み。本評価で検討した2ツールは：

1. **Impeccable**: **推奨（導入）** — 設計品質ゲートとしてCIまたは開発ワークフローに組み込む価値がある。特に `npx impeccable detect` による静的スキャンは、既存の全HTMLページで即実行可能。
2. **Claude-SEO**: **参考（保留）** — 既存X-0013ツールでカバーできていないGEO/AEO領域の参考実装として有用だが、定期監査用途への導入は費用対効果を検証してから。

### 提言アクション

1. expo-applyサイトで検出されたimpeccable課題（contrast・heading hierarchy）を修正
2. 展示会ブース制作サイト（tetsuko.co.jp）でimpeccable detectを実施
3. Claude-SEOのGEO/AEOロジックを既存ツールへ移植を検討