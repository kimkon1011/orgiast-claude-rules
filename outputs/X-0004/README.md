# X-0004 Implementation Artifacts

> AIニュース提案 X-0004「LLMO向けサイトコンテンツの4つのポイント」の実装成果物。
> 提案書: `docs/ai-news-x0004-llmo-content-4points.md`

## 状態
- ✅ 提案書マージ済み（PR #1693 / commit `02299f9a`）
- ✅ 分岐 `auto/20261108-x0004-llmo-content-4points` 削除済み
- ⏳ 実装: 本サイト(tetsuko.co.jp / Next.js + Vercel / リポジトリ: tetsuko-unified)への適用待ち

## 成果物一覧

| ファイル | 内容 | 優先度 |
|---------|------|--------|
| `faq-content.md` | FAQ 18問 + JSON-LD雛形 | P0 |
| `tetsuko-llms.txt` | llms.txt 本文 | P1 |
| `robots-ai.txt` | robots.txt + ai.txt 統合案 | P0 |

## 実装手順（tetsuko-unified リポジトリで実行）

### P0: robots.txt + ai.txt 設置（0.5日）
1. `web/public/robots.txt` に AI クローラー許可設定
2. `web/public/ai.txt` に利用許諾範囲を記載
3. デプロイ: `cd web && npx vercel --prod --yes`
4. 確認: `curl -sI https://tetsuko.co.jp/robots.txt | head -5`

### P0: FAQ ページ新設（2日）
1. `web/src/app/faq/page.tsx` 作成
2. FAQ JSON-LD を埋め込み（`schema.org/FAQPage`）
3. ヘッダーナビに「よくある質問」リンク追加
4. デプロイ + Google Rich Results Test で確認

### P1: llms.txt 設置（0.5日）
1. `web/public/llms.txt` にサイト概要と更新日を記載
2. デプロイ

### P1: JSON-LD 拡充（1日）
- トップページに `schema.org/Organization` + `LocalBusiness` JSON-LD
- 各材質カテゴリページに `schema.org/Product` JSON-LD

## 参考
- 提案書: `docs/ai-news-x0004-llmo-content-4points.md`
- X-0007: LLMO効果測定（改善前後のスコア比較）
- expo-apply AI可読化実装（PR #1688 参考実装）
