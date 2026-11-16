# X-0034 SEOスキル再現実行ランブック（部分採用は kim 承認後のみ）

AIニュース提案 [X-0034]「AIコーディングエージェントにSEOスキル追加（`npx skills add Illyism/seo-skills`）」を、オージャストの展示会ブース制作・イベント関連サイトで再現実行するための手順書。**この文書の作成時点でスキルは一切インストールしていない。**

## 1. 前提: X-0026 の判定（原文引用）

出典: `docs/ai-news-x0026-seo-skills-security-audit.md`（対象 HEAD `805c9c8261e60716e17efe6b834b0be7248d9ebb`、2026-11-13）

- 判定: 「契約 C2 に従い重大所見あり → **導入せず**」（stop_reason=scope-boundary）
- 重大所見3点:
  1. `.mcp.json` / `gemini-extension.json` が第三者リモート MCP 3 件（aiseotracker.com / scribiz.com / awesome.tools）を自動登録する
  2. `seo/seo-autopilot/SKILL.md:105-106` が実行時に `https://linkdr.com/SKILL.md` と `https://aiseotracker.com/docs` を「読んで従え」と指示する（外部指示の動的取込）。`seo/linkdr/SKILL.md` も「ライブ版が新しければライブ版に従え」
  3. リポジトリ全体に LICENSE がない（再利用許諾が不明）
- 再開条件: **kim が部分採用を承認した場合のみ**

> **`npx skills add Illyism/seo-skills` は、kim の部分採用承認前は実行禁止。** 承認後も、本書 §2 の部分採用手順を使い、この 1 コマンドは使わない。

注記: `docs/ai-news-x0040-seo-skills-npx-install.md` §7.1 には「インストール成功（`.agents/skills/`）」とあるが、X-0026 は同 docs を「概要のみ」としている。本ランブック作成時点で、このリポジトリに `.agents/` は存在しない（2026-11-14 確認）。x0040 の検証記述は根拠不明として扱い、X-0026 の判定を優先する。

## 2. 部分採用手順（承認後のみ）

| # | 手順 | 具体的な内容 |
|---|---|---|
| 1 | 隔離ディレクトリを作る | 本番リポジトリ外の空ディレクトリ（例 `~/seo-skills-review/`）に取得する。`.claude/skills` と `~/.claude/skills` へは直接入れない |
| 2 | SHA を固定して取得 | `gh api repos/Illyism/seo-skills/contents/<path>?ref=805c9c8261e60716e17efe6b834b0be7248d9ebb` で、必要な SKILL.md 本文だけを取得する。ブランチ名 HEAD は使わない |
| 3 | 取込対象を限定 | SKILL.md 本文のみ。`.mcp.json` と `gemini-extension.json` は取得せず、存在しても無視する |
| 4 | `linkdr` を除外 | `seo/linkdr/` は取り込まない（有料バックリンク発注とライブ版追従指示を含むため） |
| 5 | 外部 URL 読込指示を削除 | SKILL.md 内の「URL を読んで従え」型の行を削除する（seo-autopilot の 105-106 行付近）。出典リンクのみ残してよい |
| 6 | 人が差分確認 | 取込後の本文を kim または担当者が目視確認してから `.claude/skills/<name>/SKILL.md` に配置する |
| 7 | 配置後に固定 | 配置したファイルをコミットし、以後の更新は SHA を上げる PR でのみ行う |

`npx skills add` 1 コマンドとの差分と理由:

| 観点 | npx 1 コマンド | 部分採用 | 理由 |
|---|---|---|---|
| 版 | 取得時点の最新 | SHA 固定 | 取得元が後から書き換わるリスクを避ける |
| MCP | 第三者 3 件が自動登録 | 登録しない | 重大所見 1 |
| 外部指示 | 実行時に取込 | 削除 | 重大所見 2 |
| linkdr | 含む | 除外 | 有料発注導線の混入防止 |
| 範囲 | 30 スキル一括 | 必要な 3〜5 本 | 最小権限 |
| ライセンス | 不明のまま | 未解決のまま社内利用に限定。再配布しない | 重大所見 3 |

外部の最新状況: 2026-11-14 時点で `Illyism/seo-skills` の HEAD は `805c9c82…` のまま（`gh api repos/Illyism/seo-skills/commits/HEAD` で確認）。以降は時間で変わるため、承認時に再確認する。

## 3. ユースケース（対象: orgiast.jp、rebooth.co.jp、orgiast-product.jp、event-shop.jp）

どのユースケースでも、成果物は下書きまで。本番サイトへの反映・外部送信は行わず、PR か Drive 文書で人が確認する。

### 3.1 SEO 監査

| 項目 | 内容 |
|---|---|
| 使うスキル名 | `seo-roast`（監査・批評）。技術面の補助に `internal-linking`（スクリプトは SITE 環境変数のサイトをクロールするだけ） |
| 入力 | 対象 URL（例 `https://orgiast.jp/`）。既存ファイルは自社サイトのクロール結果 `output/crawl-results.json`（`booth-kw-research` Phase 1 の出力） |
| 出力 | 改善点の優先順位表（タイトル・メタ・見出し・内部リンク・構造化データ）を Markdown で 1 本 |
| 成功の確認方法 | 指摘された URL を 3 件以上抜き取り、実ページの現状と一致するかを curl で突き合わせる。一致しない指摘は「不採用」と記録する |

### 3.2 キーワード研究

| 項目 | 内容 |
|---|---|
| 使うスキル名 | `content-coverage`（網羅度分析）。外部 API を使う `ahrefs-research` と `dataforseo-serp` は、キーと送信範囲の承認が別途必要なので初回は使わない |
| 入力 | `data/competitors.json` の競合 URL、既存の GSC エクスポート CSV（あれば） |
| 出力 | 展示会ブース制作の優先キーワード表（意図・競合の有無・推奨ページ） |
| 成功の確認方法 | 出力に既存 `booth-kw-research` の `output/` の上位キーワードが含まれるか照合する。新規に出たキーワードのうち 5 件を手で検索し、実在する需要か確認する |

### 3.3 ブログ投稿最適化

| 項目 | 内容 |
|---|---|
| 使うスキル名 | `blog-refresher`（6 フェーズ、5 番目が承認チェックポイント）＋ `seo-title-optimization` |
| 入力 | 既存ブログ記事 1 本の URL とソース（WP 本文または Markdown）。優先語は X-0040 §3.4 のキーワード |
| 出力 | 現状分析・ギャップ表・改善案（タイトル 50〜60 字、メタ 150〜160 字、FAQ）。再作成した本文は下書きとして別ファイル |
| 成功の確認方法 | チェックリスト（タイトル字数、メタ字数、冒頭 100 語に主要語、FAQ の有無）を機械的に数えて全項目 OK か確認する。公開は人の承認後 |

## 4. 既存 docs・skill との重複と差分

| 既存 | 既存の内容 | 本書の扱い |
|---|---|---|
| `ai-news-x0040-seo-skills-npx-install.md` | 30 スキル一覧、seo-autopilot・blog-refresher の機能説明、導入計画 | 再掲しない。本書は安全な導入手順（§2）とユースケースの入出力・検証（§3）だけを新規に定義 |
| `ai-news-x0026-seo-skills-security-audit.md` | 監査表と判定 | §1 で判定のみ引用。監査表は再掲しない |
| `ai-news-x0005-seo-autoimprove-runbook.md` | GA4 導入からタイトル・メタ最適化までの WP 手順 | 参照のみ。GA4 と WP の実作業は x0005 に従う |
| `ai-news-x0017-seo-toolchain-workflow.md` | 5 段階の AI ツール連鎖 | 参照のみ。本書はスキルを使う場合の入口を定義 |
| `ai-news-x0018-seo-content-ai-workflow.md` | AI 執筆 7 ステップ、プロンプト | 参照のみ。3.3 の本文作成時に x0018 のテンプレを使う |
| `ai-news-x0013-evaluation-impeccable-claude-seo.md` | Claude-SEO 評価（導入は慎重に） | 参照のみ。同じ「第三者スキルは慎重に」の方針 |
| skill `booth-kw-research` | クロール→キーワード→分類→提案の 4 フェーズ。orgiast.jp と関連ドメインが対象 | 重複させない。3.2 はこの出力を入力に使い、スキル側は網羅度の補完だけを担う |

## 5. kim の判断事項（承認文面全文）

【kim 確認用の全文】

> X-0034（SEOスキル）について、`npx skills add Illyism/seo-skills` は実行しません。次の部分採用だけを承認しますか。
> 1. 取得元は Illyism/seo-skills の固定コミット `805c9c8261e60716e17efe6b834b0be7248d9ebb`。
> 2. 取り込むのは SKILL.md 本文のみ。対象は seo-roast、content-coverage、blog-refresher、seo-title-optimization、internal-linking の 5 本。
> 3. linkdr は除外。`.mcp.json` と `gemini-extension.json` は無視。外部 URL を読んで従う指示は削除。
> 4. 隔離ディレクトリで差分を確認してから `.claude/skills` に置く。
> 5. 本番サイトの変更・外部 API 利用（Ahrefs、DataForSEO）・外部への送信はしない。
> 6. LICENSE がないため社内利用に限り、再配布しない。
> 「承認」「却下」「5本の選び直し」のどれかで返答してください。

承認前の副作用はゼロ（インストール、外部送信、本番サイト変更はいずれも行っていない）。
