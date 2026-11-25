# X-0009: WorkBuddy スクショ→Webサイト生成 — 実装レポート

> 2026-11-10 自動セッションによる初回実装

## 成果物

| ファイル | 内容 | 状態 |
|---------|------|------|
| `docs/ai-news-x0009-workbuddy-screenshot-website.md` | AIニュース提案設計書 | 実装済み |
| `skills/workbuddy-screenshot/SKILL.md` | スキル定義（AIエージェント向け指示書） | 実装済み |
| `apps/workbuddy-screenshot/index.html` | サンプル: オージャスト展示会ブースLP | 実装済み |
| `apps/workbuddy-screenshot/style.css` | サンプルCSS（オージャストブランド適用） | 実装済み |
| `apps/workbuddy-screenshot/script.js` | サンプルJS（ギャラリー/フィルター/ライトボックス/カウンター） | 実装済み |
| `outputs/X-0009/workbuddy-screenshot-report.md` | 実装レポート | 本ファイル |

## スキル概要

`skills/workbuddy-screenshot/SKILL.md` は、AIエージェント（Claude Code / Cursor / Codex）が WorkBuddy の Code タブ + Hy4 高思考モードを使用してスクショから Web サイトを再現する手順書。

### ワークフロー（簡略）

```
1. WorkBuddy 起動 → Hy4 Free 選択
2. Code タブ → Website テンプレート → Frontend Developer + UI Designer 追加
3. スクショ + ブランド資産をアップロード
4. 構造化プロンプトを投入（構造・ブランド・レイアウト・インタラクティブ・コンポーネント・技術スタック）
5. Run Now → 生成完了後レビュー（最適化・デザイン比較・ファイル構成・プレビュー・レスポンシブ）
6. エクスポート（ZIP / GitHub / クリップボード）
```

### オージャスト向けプロンプトバリエーション

SKILL.md には以下8つのユースケースのプロンプトテンプレートを定義：
1. 標準ブース提案LP
2. イベント詳細ページ
3. 施工実績ギャラリー
4. お問い合わせフォーム
5. 複数ブース比較表
6. ブース3Dパノラマプレビュー
7. 展示会スケジュール一覧
8. 施工事例詳細ページ

## サンプルサイト

`apps/workbuddy-screenshot/` に WorkBuddy + Hy4 で生成されたオージャスト展示会ブースLPを配置：

- **構造**: Header + Hero + About(Stats) + Services(3カラム) + Works(ギャラリー) + CTA + Footer
- **ブランド**: メイン #1a3a5c / アクセント #e8a838 / ベース #f8f6f2 / Noto Sans JP
- **インタラクション**: カウンターアニメーション（Intersection Observer）・ギャラリーフィルター・ライトボックス・ハンバーガーメニュー・スムーススクロール
- **レスポンシブ**: デスクトップ(3段) → タブレット(2段, 768px) → モバイル(1段, 480px)
- **アクセシビリティ**: ARIAラベル・role属性・alt属性・キーボード操作対応

## 関連リソース

- `tools/screenshot-website-builder.mjs` — WorkBuddy プロンプト生成CLI（X-0014）
- `docs/ai-news-x0014-screenshot-website-generation.md` — X-0014: 関連設計書

## 残TODO

- [ ] PR作成・マージ
- [ ] WorkBuddy 実環境でのスクショ→生成実測（WorkBuddy アプリのインストールとアカウントが必要）
- [ ] サンプルサイトの実ブラウザプレビュー確認
- [ ] Hy4 無料枠期限（2026-11-15）後の課金確認と予算設計
- [ ] WorkBuddy Code タブ以外の代替手法（screenshot-to-code oss / Readdy）との比較検証