# User-global preferences (kim@orgiast.jp)

## Next.js 開発

- `next.config.*` / `app/**/layout.tsx` を触ると **rules/nextjs.md** が自動適用される（不具合・要望フォーム必須・read-back verify）
- 社内アプリの投稿窓口は **`tools/feedback-kit/`** を1コマンド導入（`node tools/feedback-kit/install.mjs --app . --name "<アプリ名>"`）。必須6機能の欠落は `verify.mjs` が検出し、`feedback-form-gate.mjs` がデプロイを deny する

## Growi 社内マニュアル取り込み

**/growi-fetch** skill を使う（一次ソース = Drive `社内マニュアル_NotebookLM連携` 13分割 Docs、WebFetch 禁止、鮮度チェック必須）。

- 見送り・中止・キャンセルになった案件は、カレンダー予定を削除し、期限台帳を見送りまたは完了で閉じる（備考に日付と出典）。

- 予定の件名には必ずクライアント名と案件名を入れ、管理番号（C0039、D-150、S-xxx など）は末尾の補足だけにする。

- Discordの面談設定などから自動で作る応募者・求人の面談予定は、seisaku-team@orgiast.jp のカレンダーに作り、kim@orgiast.jp は参加者に入れず、kim のカレンダーにも作らない。

- 人が絡む作業は手間チェック必須（ONBOARDING の絶対ルール参照）。

- 全送信直前の7項目は `tools/send-consistency-check.mjs` で照合し、不一致・取得不能なら停止。送信後はsent-registryと元下書き・再送予定を読み戻す。
