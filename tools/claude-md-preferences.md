# User-global preferences (kim@orgiast.jp)

## Next.js 開発

- `next.config.*` / `app/**/layout.tsx` を触ると **rules/nextjs.md** が自動適用される（不具合・要望フォーム必須・read-back verify）
- 社内アプリの投稿窓口は **`tools/feedback-kit/`** を1コマンド導入（`node tools/feedback-kit/install.mjs --app . --name "<アプリ名>"`）。必須6機能の欠落は `verify.mjs` が検出し、`feedback-form-gate.mjs` がデプロイを deny する

## Growi 社内マニュアル取り込み

**/growi-fetch** skill を使う（一次ソース = Drive `社内マニュアル_NotebookLM連携` 13分割 Docs、WebFetch 禁止、鮮度チェック必須）。
