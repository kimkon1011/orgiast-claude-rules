# X-0003 n8n 事前構築ワークフロー取り込み評価（途中経過: C1・C2 まで）

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
- 本番 n8n の稼働有無は未確認（memory・環境変数に n8n 痕跡なし）→ 本番投入しない（A2）。
- C3（静的審査）・C4（隔離インポート）・承認依頼文は未実施。
