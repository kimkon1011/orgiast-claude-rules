---
paths:
  - "**/next.config.*"
  - "**/app/**/layout.tsx"
  - "**/src/app/**/layout.tsx"
---

# Next.js 開発ルール（orgiast 全プロジェクト共通・絶対ルール）

## 1. 不具合・要望フォームを必ず入れる（省略禁止）
社員が使うアプリは投稿窓口が必須（ONBOARDING §2.11）。**新規作成時・既存改修時に未搭載なら、その場で `node packages/feedback-kit/install.mjs --app . --name "<アプリ名>"` を必ず実行**する（kit が `packages/feedback-widget/` の `FeedbackWidget.tsx` / `api-route.ts` を配置し、`tools/feedback-zero-registry.json` へ登録する）。既存アプリの更新は `--upgrade`（旧フォームは `.feedback-kit-backup/` へ退避）。

導入後は `node packages/feedback-kit/verify.mjs --app .` で必須6機能（`image-attach` / `kind-toggle` / `title-optional-body-required` / `notify-on-submit` / `dm-submitter-on-done` / `zero-backlog-registered`）の欠落ゼロを確認する。`tools/feedback-form-gate.mjs` が `vercel deploy` / `vc.js deploy` 直前に未導入を deny するため、入れ忘れるとデプロイできない。

## 2. 本番反映は read-back まで
`vercel deploy --prod` 後は本番 URL を実際に開いて反映を確認する（`/deploy-verify` skill）。フォーム導入時は `node packages/feedback-widget/verify.mjs --url <本番URL>` で実投稿+read-back まで通してから完了とする（§1.4）。

## 3. 機密値は env へ
`FEEDBACK_OWNER_DISCORD_ID` 等は `.env.local`（gitignore 済み）に置き、コード・公開リポジトリに書かない。Supabase の service role key も同様。
