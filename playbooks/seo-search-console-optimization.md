aliases: [SEO, search-console, seo-workflow, X-0004]

# SEO最適化ワークフロー — Search Console + Claude Code

出典: [@ChadSE0](https://x.com/i/web/status/2117304403585593775) の19ステップ手法を、orgiast-claude-rules / TETSUKO サイト向けに具体化したもの。
AIニュース提案 [X-0004] として採択・運用化。本プレイブックは TETSUKO の SEO 作業時に参照する。

## 前提条件

### 既に完了していること（再確認不要）
- GA4 タグ設置済み（`G-1HZHDD29S2` → `web/.env.production` → 本番全ページに出力確認済み）
- sitemap.xml 送信済み（3,477 URL、Search Console `sc://tetsuko.co.jp/` に送信。ステータスは「不明→成功」の確認待ち）
- Search Console 所有権確認済み（`https://tetsuko.co.jp/` URLプレフィックス型）
- 参照: `memory reference_tetsuko_analytics.md`、`docs/growth/analytics-searchconsole-verification-20260930.md`

### このワークフロー実行に必要なもの
- **Search Console データエクスポート**: Queries.csv + Pages.csv（直近3ヶ月）。CLI からの API 照会は SA 鍵無しのため不可（`tools/google-property-check.mjs` が keyserve 401 で失敗する）。
  → kim に Search Console Web UI からの CSV エクスポートを依頼する（genbateam.toho@gmail.com でログイン可能）。
- **TETSUKO サイトリポジトリ**: `tetsuko-unified`（`C:/Users/user/Documents/tetsuko-unified`）。SEO 変更の実作業はこのリポジトリで行う。

### 既知の制約
- `tools/google-property-check.mjs` は SA 鍵欠如のため実行不可（DWD API 照会不能）。keyserve enroll が human-only。
- 本番に対する変更は `vercel --prod` の前に着手可否の確認が必要（classifier が本番書き込み操作をブロックすることがある）。
- Web 上から取得できる生の一次情報: `curl https://tetsuko.co.jp/`（GAタグ確認）、`curl https://tetsuko.co.jp/sitemap.xml`（URL件数確認）、`curl https://tetsuko.co.jp/robots.txt`（Sitemapディレクティブ確認）— これらは毎回その場で取得可能であり、最初に確認する。

## 19ステップワークフロー

### Phase 1: データ準備（1–2）

1. **Search Console から3ヶ月分のデータをエクスポート**
   - Queries.csv: クエリ別のインプレッション・クリック・CTR・掲載順位
   - Pages.csv: ページ別の同指標
   - 保存先: `tetsuko-unified/data/seo/`（Git管理対象外でもよいが、`.gitignore` 確認）
2. **CLAUDE.md にサイト情報を記述**
   - サイトが売るもの（例: 金属加工・展示会ブース・名札・コースターの製造販売）
   - 対象顧客（例: 東邦鋼業の既存取引先、展示会出展企業、飲食店）
   - 次のアクション（例: このワークフローに従いSEO最適化する）
   - → `tetsuko-unified/CLAUDE.md` に追記（既存のものがあれば内容確認後に追記）

### Phase 2: 改善レバー特定（3–6）

3. **5つのレバーを順に評価する**
   1. **意図マッチ**: クエリの検索意図にページ内容が合致しているか
   2. **タイトル＋キーワード**: タイトルにターゲットKWが含まれ、最初の単語になっているか
   3. **内部リンク**: 関連トピックからページへのリンクが十分か
   4. **権威**: 被リンク・サイト全体の権威は十分か（技術的制約あり）
   5. **ページリンク**: 本文から別ページへの適切なリンクがあるか

4. **基本ルールを確認する**
   - 存在しないページへのリンクがないか（curl で全確認は現実的でない→影響範囲の大きなものだけ）
   - ランキングしているクエリへの変更は慎重に（変更前後で Search Console データを確認）
   - 1日1ページを最大とする（連続変更による Google のペナルティリスク回避）

5. **完了チェックリストを定義する（作業開始前に）**
   - 例: 「このクエリのタイトルを変更」「内部リンクを3つ追加」「変更後ページは404にならない」
   
6. **レッスンファイルを保持する**
   - 前回の作業から学んだ教訓を `tetsuko-unified/data/seo/lessons.md` に追記
   - 最新の内容が優先される（上書きではなく追記＋日付で管理）

### Phase 3: クエリ選定（7–9）

7. **ポジション5–20のクエリをインプレッション順に取得**
   - Queries.csv をフィルタ: `5 <= 掲載順位 <= 20`
   - インプレッション降順でソート
   - `head -20` で候補を絞る

8. **ビジネスポテンシャルでフィルタ**
   - TETSUKO の商材に関連するクエリか（金属加工・名札・コースター・キーホルダー・記念品など）
   - 購入意図があるか（「作り方」「とは」より「注文」「価格」「業者」）
   - フィルタ後のクエリ一覧を `data/seo/target-queries.md` に保存

9. **クエリごとに既にインプレッションがある1ページを作業対象に**
   - 複数ページに分散していないか確認 → 最もインプレッションの多い1ページに集中
   - そのページの現在のクリック数を記録（変更後90日の比較基準）

### Phase 4: ページ改善（10–16）

10. **編集前にそのページの現在のクリック獲得内容をリスト**
    - 現状の流入クエリ上位5件
    - 各クエリの掲載順位・CTR・クリック数
    - 保存: `data/seo/pre-optimization-<slug>.md`

11. **Google 1ページ目を読む（競合分析）**
    - 検索意図・ユーザーの質問・SERP の手がかり（サイドパネル、「People also ask」）
    - 競合ページは最後に見る（誘導されないため）
    - `tools/web-search.mjs` または `WebFetch` ツールで取得

12. **タイトルを最適化する**
    - キーワードを最初の単語に
    - 約束を含める（例: 「即日対応」「最短見積もり」「業務用」）
    - 年を含める（例: 「2026年最新」※ただし誇大でないもの）
    - 600px以下（Google SERP の表示幅制限）

13. **完璧なページを手で作成しテンプレートとして保存**
    - 最初の1ページは template として `data/seo/page-template.md` に保存
    - 後続ページの基準にする（見出し構成・情報設計・CTA）

14. **同じトピックから3–5の内部リンクを追加**
    - テキスト内から自然な文脈で（フッターやサイドバー不問）
    - 対象ページのカテゴリページ・関連製品・事例ページなど

15. **正確なキーワードをアンカーテキストに**
    - 同じアンカーテキストを2ページで使い回さない（Google の過剰最適化判定を避ける）

16. **ボディリンクをクロール確認**
    - `sitemap.xml` のクロールは「サイトマップ送信」であって「リンククロール」ではない
    - 実際の本文中リンク（`<a href="...">`）が正しいか、404になっていないか
    - → 全リンクの検証は大規模なため、編集したページに含まれるリンクをテスト

### Phase 5: 測定と反復（17–19）

17. **変更後90日間は判断を保留**
    - Google のインデックス更新・順位変動の安定に最低90日
    - この間は同一ページへの追加変更をしない（レッスンファイルに記録のみ）

18. **Search Console の正確なクエリフィルタで判断**
    - 変更したページに対するクエリ単位で「変更前90日」vs「変更後90日」を比較
    - 統計的有意差が確認できるまで判断保留

19. **週次で5クリック以上動いたページのみ次週の作業対象にする**
    - 5クリック未満 = ノイズ（NOOP と判断）
    - 5クリック以上の変動があったページから次の最適化候補を選定

## 初回実行の手順

ワークフロー全体を初めて実行する際の具体的な手続き:

```text
1. kim に Search Console CSV エクスポートを依頼（genbateam.toho@gmail.com）
   → C:/Users/user/Documents/tetsuko-unified/data/seo/ に配置
2. リポジトリの CLAUDE.md 確認 → サイトの説明セクションを追加
3. Phase 3 のクエリフィルタを実行（ツール未実装の場合は手動フィルタから）
4. 最もポテンシャルの高いクエリ1件に絞り Phase 4 を実施
5. デプロイ後、Google の Index 確認に curl で該当ページの存在確認
6. 変更内容を lessons.md に記録
7. 90日後の再評価を next-session.md に残TODOとして予約
```

## 参照
- [codex-delegate](codex-delegate.md) — SEO 変更の実装を Codex に委譲する場合の手順
- `tools/web-search.mjs` — SERP 競合分析に使用
- `tools/google-property-check.mjs` — Search Console データ照会（SA鍵配備後に使用可）
- TETSUKO 計測基盤: `memory reference_tetsuko_analytics.md` または `docs/growth/analytics-searchconsole-verification-20260930.md`