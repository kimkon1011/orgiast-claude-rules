---
name: web-perf
description: Webサイトのパフォーマンス診断を行う。PageSpeed Insights・Lighthouse を CLI で実行し、スコア・改善点・推定効果を報告する。展示会ブース制作サイト（WordPress/Vercel）の速度改善に使う。「速度診断」「パフォーマンス診断」「perf」「web-perf」「PageSpeed」「Lighthouse」と言われたらこのスキルを使う。
---

# Web パフォーマンス診断（web-perf）

展示会ブース制作サイトの表示速度を診断し、具体的な改善施策を出す。

## 1. 診断実行

- 現場のサイト URL に対して `npx lighthouse <URL> --output json --chrome-data-path /tmp/lighthouse` または `curl` 経由で PageSpeed Insights API（`https://pagespeedonline.googleapis.com/v5/runPagespeed?url=<URL>&strategy=mobile`）を叩く。
- 計測項目: モバイル／デスクトップ両方の Total Score・FCP・LCP・TBT・CLS・SI・レポート全文。
- PageSpeed API の取得項目: `lighthouseResult.categories.*.score`、`lighthouseResult.audits.*.score`、`loadingExperience`（CrUX データ有無）。

## 2. 診断結果の報告

数値は表（項目／モバイル／デスクトップ／目標）で出し、以下を同梱:
- スコア（モバイル・デスクトップ）
- 最大の改善余地がある項目 TOP3（推定スコア改善幅付き）
- 直せるもの（設定変更・画像圧縮・フォントサブセット・JS 非同期化）と直せないもの（広告・サードパーティJS）の仕分け

## 3. 改善案

各改善項目に「難易度（低/中/高）・推定効果・手順の具体例」を付ける。WordPress ならプラグイン・functions.php・テーマ子編集の3案を、Vercel なら vercel.json・next.config.js の設定を併記する。

## 4. 検証

改善適用後、同じ URL で再診断し、前後のスコアを差分表で出す。変化がない or 低下がある場合は原因を推定して追記する。