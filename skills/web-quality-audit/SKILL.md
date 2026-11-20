---
name: web-quality-audit
description: Webサイト全体の品質を包括的に監査する。パフォーマンス・アクセシビリティ・SEO・セキュリティ・HTML/CSS/JS の品質をチェックし、総合レポートを生成する。展示会ブース制作サイトの品質向上に使う。「品質監査」「クオリティ監査」「quality-audit」「web監査」「総合診断」と言われたらこのスキルを使う。
---

# Web 品質包括監査（web-quality-audit）

展示会ブース制作サイトを多角的に監査し、品質スコアと改善施策を提供する。

## 1. 監査項目

| 次元 | ツール・手法 | チェック項目 |
|---|---|---|
| パフォーマンス | Lighthouse / PageSpeed API | スコア・FCP・LCP・CLS・TBT・画像圧縮 |
| アクセシビリティ | axe-core / Lighthouse a11y | コントラスト比・alt 代替テキスト・見出し階層・フォーカス順序・キーボード操作 |
| SEO | メタ抽出 / robots.txt / sitemap.xml | title・description・ canonical・hreflang・構造化データ・パンくず |
| HTML/CSS | W3C Nu Html Checker / stylelint（lint 可能範囲） | 構文エラー・重複 id・冗長セレクタ・!important 件数 |
| JS | eslint（lint 可能範囲） | console.log 残存・未使用変数・非同期エラーハンドリング欠落 |
| セキュリティ | Security Headers（CSP・X-Frame-Options・HSTS）・SSL Labs | ヘッダー不足・TLS 1.3・脆弱性既知ライブラリ |

## 2. 監査実施手順

1. ツール別に並行実行（Agent 委譲可）。収集結果を統合
2. 各次元のスコア（A〜F）と全体スコア（加重平均）を算出
3. 致命度（P0=危険 / P1=要対応 / P2=推奨）でグルーピング
4. 指摘ごとに「現状」「基準」「直し方」「期待改善幅」を記載

## 3. 報告と改善

- スコアカード形式（レーダーチャートが理想）で提示
- 実施コスト見積もり（工数・難易度）を添える
- P1 以上の指摘を全て修正するまで担当し、修正後に再監査してスコア改善を確認する