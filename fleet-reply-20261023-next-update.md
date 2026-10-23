更新実行の実測結果です。PCのNode.js（Windows/WSL）は変更していません。

| 対象 | 更新前の版 | 更新後の版 | 証拠（コマンド出力・PR URL・本番 URL と HTTP） | できなかった理由 |
|---|---:|---:|---|---|
| kimko-PC Node.js | 対象外 | 変更なし | `npx vercel whoami`表示内の実行Nodeは24.19.0（OS側の更新操作なし） | 指示どおりsetup配布側に委ねた |
| nf-minpaku-automation | Next.js該当なし（依頼記載） | 変更なし | ローカルcloneなし、`git ls-remote`でGitHub到達のみ確認 | このPCの自己アカウント対象だがNext.js更新対象なし |
| event-shop / stagecue / 購買管理アプリ | 16.2.10 / 16.3.4 / 15.5.18（棚卸し値） | 未変更 | 指定パス `D:\Claude\event-shop`,`D:\Claude\stagecue` は共にFalse | nishi-PC対象で、このkimko-PCにcloneなし |
| cafe-checklist-app | 14.2.35（棚卸し値） | 未変更 | cloneなし。`git ls-remote https://github.com/nishiOrgiast/cafe-checklist-app.git` → `Repository not found`。GCM=`seisaku-team-org`、Vercel=`Logged out` | nishi所有のprivate repoへこのPCの資格情報ではアクセス不可。codemod/build/draft PR不可 |
| kimkon1011指定8repo | kim-PC更新済み | 変更なし | C:\Users\kimko配下のgit clone検索で該当0件 | cloneがないためpull対象なし |

PR・本番再デプロイ・HTTP 200確認は、更新可能な対象がこのPCに無かったため0件です。
