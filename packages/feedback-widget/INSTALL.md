# フィードバック機能 移植仕様書

## 自動導入（推奨）

```sh
node -e "fetch('https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/packages/feedback-widget/install.mjs?cb='+Date.now()).then(r=>r.text()).then(t=>{require('fs').writeFileSync('install-feedback.mjs',t);})" && node install-feedback.mjs --app-name "<アプリ名>"
```

`--target <path> --discord-channel <id> --webhook <url> --no-admin-page --dry-run --force` を指定できます。Node.js 18 以降、Next.js App Router が対象です。テンプレートが手元に無い単体実行時も GitHub `main` から自動取得します。

## 環境変数

| 名前 | 用途 | 必須条件 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | REST/Auth/Storage URL | DB保存時 |
| `SUPABASE_SERVICE_ROLE_KEY` | サーバー専用REST認証 | DB保存時。クライアントへ公開禁止 |
| `DISCORD_BOT_TOKEN` | Bot REST API | Discord通知（優先） |
| `DISCORD_FEEDBACK_CHANNEL_ID` | 通知先チャンネル ID（社員ch を指定。`install.mjs --discord-channel <id>` でも指定可） | Bot 経路なら必須 |
| `FEEDBACK_DISCORD_WEBHOOK_URL` | BotがないGuild用 | Discord通知（代替） |
| `NEXT_PUBLIC_APP_URL` | 通知内の管理画面URL | 任意 |

## データモデル

`app_feedback` は UUID 主キー、`kind` (`bug/request`)、title、body、page_path、submitter、submitter_email、`status` (`new/triaged/in_progress/done/rejected`)、`priority` (`low/normal/high`)、admin_note、resolved_ref、screenshot_path、created_at、updated_at を持ちます。RLS を有効にし、アプリの読み書きは service role 経由に限定します。画像は private bucket `feedback-screenshots` に置き、authenticated 用 select/insert/update policy を作ります。正本は `templates/migration_app_feedback.sql` で、冪等に実行できます。

## API 仕様

`POST /api/feedback` に `multipart/form-data` で `kind`, `title`, `body`, `page_path`, 任意の `submitter`, `screenshot` を送ります。title/body は必須、画像は `image/*`・8MB以下です。成功は `{ "ok": true, "id": "...", "sinks": { "db": true, "discord": true } }`、入力不備等は `{ "ok": false, "error": "..." }` と 4xx/5xx です。Supabase Cookie の access token からメールを best-effort で特定します。DB/画像/Discord の一部障害は利用可能な保存先が成功する限り投稿全体を維持します。

Discord 本文は `[アプリ名] 種別: タイトル`、本文先頭300字、提出者、画面、`/feedback`、7日署名スクショURLの順です。Bot token + channel を webhook より優先します。

## 手移植

Next.js App Router では templates の API Route、Widget、Trigger、管理ページ、更新Routeを対応する `app/api/feedback/route.ts`、components、`app/feedback/page.tsx`、`app/api/feedback/update/route.ts` へ置き、root または認証済み layout に import と `<FeedbackWidget />` を追加します。SQLを Supabase SQL Editor で実行し、環境変数を本番にも設定します。

Pages Router、Remix、Vite等では同じフォームを常駐レイアウトへ置き、サーバー側で上記APIを実装します。service role は必ずサーバーだけで使用し、REST insert、Storage upload、Discord通知の順序・best-effort 方針を維持してください。React Router等では `page_path` を `window.location.pathname` から取得します。

UIは右下 amber `#f59e0b` の浮遊ボタン、最大幅480pxの白いモーダル、暗いoverlay、高いz-index、Escape/外部 `open-feedback` Event、貼り付け画像、送信中disable、成功toast、失敗時に閉じないエラー表示を必須とします。`role="dialog"` と `aria-modal` も維持します。

## 検証

デプロイ後、パッケージ一式が手元にある場合は次を実行します。

```sh
node packages/feedback-widget/verify.mjs --url https://<app>.vercel.app --target <repo>
```

1行導入でローカルに `verify.mjs` が無い場合は、インストーラーの最終出力にも表示される次のコマンドを実行します。

```sh
node -e "fetch('https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/packages/feedback-widget/verify.mjs?cb='+Date.now()).then(r=>r.text()).then(t=>require('fs').writeFileSync('verify-feedback.mjs',t))" && node verify-feedback.mjs --url https://<app>.vercel.app
```

API投稿、sinks、service role がローカルにあればDB read-backを確認し、テスト行を削除せず `rejected` に更新します。`--keep` なら更新もしません。管理画面で提出が見え、Discord本文と署名画像が開けることが完了判定です。
