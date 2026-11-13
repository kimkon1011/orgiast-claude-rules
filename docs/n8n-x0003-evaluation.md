# X-0003 n8n 事前構築ワークフロー取り込み評価（途中経過: C1〜C3 まで）

## C1 出典（実取得 2026-11-04, gh api）
- リポジトリ: https://github.com/enescingoz/awesome-n8n-templates （stars 26252, 非アーカイブ）
- 固定 SHA: `827110332c21cbe000ab13f6d292d5adb1f1f8db`（2026-09-12）
- ライセンス: CC BY 4.0（LICENSE 本文・README バッジ。GitHub API の spdx は NOASSERTION）。帰属表示が必要。
- 総数: .json blob 369 件（うち `Other/ALL_unique_nodes.json` 等 非ワークフローを含みうる）。提案文・README の「280+」と相違（実数が多い）。
- カテゴリ: トップ階層 19 ディレクトリ。提案文・README の「18」と相違。

## C2 候補（上限 5 件・全て固定 SHA 上のパス。取得物は tmp の専用空ディレクトリのみ）
| # | ワークフロー | 用途 | 選定理由 | 必要認証情報 | 外部送信先 | 区分 |
|---|---|---|---|---|---|---|
| 1 | Forms_and_Surveys/Qualifying Appointment Requests with AI & n8n Forms | 問い合わせ受付＋AI 振分け | フォーム受付→分類→承認→予約/返信。25 ノード | OpenAI, Gmail OAuth2, Google Calendar OAuth2 | Gmail 送信（Receipt/Rejection/承認待ち）, Calendar 予約 | 要承認（顧客向け送信） |
| 2 | Other_Integrations_and_Use_Cases/ClientFlow Lite - Client Onboarding Automation | リード登録 | Webhook→Sheets 追記。6 ノードで小さく審査しやすい | Gmail OAuth2, Google Sheets（JSON 上は資格情報なし） | Gmail 送信（Welcome Email）, Sheets 追記 | 要承認（Welcome 送信ノードは削除/無効が前提） |
| 3 | Gmail_and_Email_Automation/Gmail AI Auto-Responder_ Create Draft Replies to incoming emails | メール一次返信下書き | 送信せず draft 作成のみ（resource=draft）。12 ノード。※JSON は active:true、import 時 false 化が必要 | Gmail OAuth2, OpenAI | Gmail 下書き作成のみ | 候補（下書き限定） |
| 4 | Gmail_and_Email_Automation/Compose reply draft in Gmail with OpenAI Assistant | メール一次返信下書き | ラベル起点で下書きを作成。送信ノードなし（Gmail API drafts へ HTTP） | Gmail OAuth2, OpenAI | googleapis.com Gmail drafts, OpenAI | 候補（下書き限定） |
| 5 | Notion/Turn Emails into AI-Enhanced Tasks in Notion (Multi-User Support) with Gmail, Airtable and Softr | メール→Notion 記録 | Notion ページ作成（api.notion.com）。Airtable 経路は不要なら外す | Gmail OAuth2, OpenAI, Airtable token, Notion | Notion API, Gmail 通知送信 2 ノード | 要承認（通知送信ノードは無効化） |

### 照合メモ
- Slack/Discord 通知用は今回上限枠に入れず（Slack/ 9 件・Discord/ 4 件は ボット・監視系で受付通知に直結せず）。通知は候補 1 の後段に別途追加する前提。必要なら iter3 で Slack/Discord を差し替え検討。
- n8n の所在（Gmail seisaku-team@ を直接照会）: n8n Cloud の workspace「orgiast」は 2026-05-27 13:02 JST に「Your n8n trial has ended」（onboarding@info.n8n.io）を受信、3日後に inactive・データは90日保持（≒2026-08 下旬まで）と記載。現在は無効または削除済みの可能性が高く、稼働中の本番 n8n は確認できていない。本番投入は承認待ちのため行わない（A2）。
- C4（隔離インポート）・承認依頼文は未実施。

## C3 静的審査（2026-11-04, tools/n8n-workflow-audit.mjs ／ 校正テスト tools/n8n-workflow-audit.test.mjs 4件 pass: 安全例 pass・危険例 reject）
審査項目: 実行系ノード(Code/Execute Command/Function/SSH)・ハードコード秘密・難読化/動的実行・外部 URL・外部送信/課金・active フラグ。審査対象は固定 SHA 上の取得物（SHA256 先頭16桁で対応）。

| # | SHA256(16) | ノード | 機械判定 | 重大指摘 | 手動/独立確認 | 採否 |
|---|---|---|---|---|---|---|
| 1 | 8a629f139b29655a | 25 | pass | なし（Gmail 送信3ノード=medium、URL は docs/community のみ） | — | 候補（送信ノード要承認・無効化前提） |
| 2 | aab4b697d91a8265 | 6 | reject(Code 1) | Code「Validate」（入力検証のみ。通信/FS/eval なし） | 本人+deepseek-v4-flash=無害 | 条件付き採用（Welcome Email 送信ノード削除前提） |
| 3 | 1182fcc95492893a | 12 | pass | なし（下書き作成のみ。active:true→false 化要） | — | 採用可 |
| 4 | 876f40e2ea016d69 | 23 | reject(Code 1) | Code「Convert raw to base64」（Buffer 変換のみ）。外部 URL は作者宣伝(workfloows.com, YouTube) | 本人+deepseek=無害 | 条件付き採用（宣伝リンクは Sticky Note 内のみ） |
| 5 | 61960ec6226e386e | 38 | reject(Code 1) | Code「Format Notion Page Blocks」（整形のみ。正規表現失敗時の例外処理なし）。固定の Airtable URL 2件が含まれる（要除去） | 本人+deepseek=要注意（軽微） | 条件付き採用（通知送信2ノード無効化・Airtable URL 除去） |

- 機械判定は Code ノードの存在だけで保守的に reject とする設計。内容を読んだ結果、ハードコード秘密・難読化・ネットワーク/FS/プロセス操作は 5 件とも 0。
- 独立確認は llm-ask(deepseek) による Code 本文の判定のみ。codex-do 等によるフル審査（全ノード JSON）は未実施のため、重大指摘ゼロの最終承認は C4 の前に再確認する。

## C4 隔離インポート試行（iter4・未達）
- `npm install n8n`（空の一時ディレクトリ）は Windows で EBADPLATFORM（`@napi-rs/canvas-linux-arm64-musl`）。`--force` で導入は完了したが、`node_modules/n8n/package.json` が欠落しており `n8n --version` / `import:workflow` が `Cannot find module '../package'` で終了コード 1。インポートまで到達していない。
- docker は無し。修復のため該当ディレクトリを削除して再導入する操作は classifier に拒否されたため実行していない。
- 結論: C4 は未検証（FINAL 不可）。再開条件=n8n の再導入（package.json 欠落の修復）か WSL/Linux 上での実行。本番 n8n・実データへの接続はなし。

## C4 再試行（iter5・未達）
- 新規の空ディレクトリで `npm install n8n --force` を再実行（n8n 2.46.4）。同じく `node_modules/n8n/package.json` が欠落。`npm pack n8n` の tarball から package.json を補修すると `n8n --version` は 2.46.4 を返した。
- しかし `import:workflow`（5件とも・active=false 化したコピー）は `Cannot find module 'n8n-workflow'` で終了コード 1。node_modules 内で package.json 欠落が 178/1661 パッケージあり、n8n 内部パッケージを含む。全修復は実質再導入が必要。
- WSL・docker とも無し。C4 は引き続き未検証（FINAL 不可）。インポートは一度も到達していない。
- 再開条件: Linux/WSL か docker のある環境で `npm i n8n`（--force 不要）して `N8N_USER_FOLDER` を tmp にし、`n8n import:workflow --input=<active=false 化した候補>` → `export:workflow` でノード数一致を確認する。

## 本番投入の承認依頼文（C5）
【kim 確認用の全文】
X-0003（n8n 事前構築ワークフロー）の評価結果です。
- 出典: https://github.com/enescingoz/awesome-n8n-templates（SHA 827110332c21cbe000ab13f6d292d5adb1f1f8db, CC BY 4.0・帰属表示要）。提案文の「280+／18カテゴリ」に対し実数は json 369件／19ディレクトリ。
- 採用候補: 候補3「Gmail AI Auto-Responder」（下書き作成のみ・最優先）／候補4「Compose reply draft in Gmail with OpenAI Assistant」（宣伝リンクは Sticky Note 内のみ）／候補2「ClientFlow Lite」（Welcome Email ノード削除が前提）／候補1・5 は顧客向け・通知送信ノードの無効化が前提。
- リスク: Code ノードは候補2・4・5 に1件ずつ（内容は整形・検証のみで無害と機械判定＋deepseek で確認。全ノード独立審査は未実施）。候補3 は元 JSON が active:true のため取り込み時に false 化が必要。隔離インポート検証（C4）は未達で、動作未確認。
- 必要認証情報: OpenAI API キー、Gmail OAuth2（seisaku-team@orgiast.jp）、Google Sheets／Calendar OAuth2、Notion、Airtable（候補5のみ）。
- n8n の所在: n8n Cloud の trial は 2026-05-27 に終了済みで、稼働中の本番 n8n は確認できていない。新規立ち上げ（n8n Cloud 有料プランまたはセルフホスト）が必要で、費用比較は未実施。
- 承認いただきたいこと: ①n8n の置き場所（Cloud 有料／セルフホスト）の決定 ②Gmail は下書き作成のみで開始してよいか。
承認前に有効化・認証登録・実データ接続は行っていません。

## 行動ログ（C5）
- iter1〜5 を通じ、外部への書き込み 0 件。取得は GitHub 読み取りと Gmail 検索のみ。ワークフロー有効化・認証登録・送信系起動なし。
