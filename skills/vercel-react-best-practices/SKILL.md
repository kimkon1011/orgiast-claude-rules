---
name: vercel-react-best-practices
description: Vercel + React（Next.js）サイトの高速化ベストプラクティスを診断・適用する。ISR・SSG・Edge Functions・画像最適化・キャッシュ戦略を点検し、展示会ブースサイトのパフォーマンスを向上させる。「Vercel高速化」「React高速化」「Next.js最適化」「vercel-react」「ISR」「SSG」と言われたらこのスキルを使う。
---

# Vercel + React（Next.js）高速化

展示会ブース制作サイトが Vercel + Next.js で構成されている場合、以下を診断して改善する。

## 1. 診断項目

- **ビルド最適化**: `next.config.js` の `swcMinify`・`compress`・`images` 最適化設定、outputFileTracing の有無
- **ISR/SSG 適用**: イベント一覧・展示会詳細ページに ISR（`revalidate`）or SSG が適用されているか。動的過ぎるページ（問い合わせフォーム・管理画面）は除外
- **Edge Functions**: Vercel Edge Config・Edge Middleware の利用有無、キャッシュヒット率
- **画像配信**: `next/image`（Image Optimization）の利用、WebP/AVIF 変換、画面幅ごとのブレークポイント
- **フォント**: Google Fonts のセルフホスティング（`next/font`）or `@next/font` 適用、`font-display: swap`
- **Analytics**: Vercel Analytics（Speed Insights）のデータで実測値確認

## 2. 改善手順

改善項目ごとに:
1. 現状の設定ファイル（`next.config.js`・`vercel.json`）を読む
2. 不足設定を特定する
3. コード差分を書く（`Edit`）
4. テストが緑であることを確認
5. デプロイ後、再度診断して効果を検証する

## 3. 展示会特化の注意点

- イベント開催前後でトラフィックが急増するため、ISR の `revalidate` 秒数は平時 300→繁忙期 60 に切り替える設計にする
- 展示会の写真（実績ギャラリー）は WebP 変換＋画面幅5段階のレスポンシブ画像を必須とする
- パンフレット PDF は Vercel の Object Storage に移し、App Router からのストリーミング配信を検討する