nishi-PC 実測（2026-10-23）。Node本体は変更なし。更新成功0件。

| 対象 | 更新前の版 | 更新後の版 | 証拠（コマンド出力・PR URL・本番 URL と HTTP） | できなかった理由 |
|---|---|---|---|---|
| event-shop | 16.2.10 | 未更新 | 別コピーで `npm install --save-exact next@16.4.1 --package-lock-only --ignore-scripts` → exit 1、`EAI_AGAIN registry.npmjs.org`。PR・本番HTTP未確認 | DNS失敗で依存取得不可。ビルド・コミット・PR・マージ・再デプロイ未実施 |
| stagecue | 16.3.4 | 未更新 | 同コマンド → exit 1、`EAI_AGAIN registry.npmjs.org`。PR・本番HTTP未確認 | 同上 |
| cafe-checklist-app | 14.2.35 | 未更新 | 別コピーで `npx @next/codemod@canary upgrade 15` → exit 1（EAI_AGAIN）。`npm run build` → `next: not found`。draft PR未作成 | codemod取得不可。既存未コミット変更は保持。手動確認候補: 開店チェック、完了、日報、売上、フィードバック |
| kimkon1011/purchasing-management-app | 15.5.18（pnpm lock） | pull不可 | `git pull --ff-only` → `cannot open .git/FETCH_HEAD: Read-only file system` | Dドライブが読み取り専用。依存変更なし |
| 指定の他7リポジトリ | 未確認 | 対象clone未検出 | C側主要開発ディレクトリ・D:/Claudeを探索 | ローカルcloneを検出できずpull未実施 |

補足: `git ls-remote` も `Could not resolve host: github.com`、`gh.exe auth status` はWSL `socket failed 1`。PR URL・HTTP 200の証拠なし。

返信コマンドも exit 1（`fleet-mail: fetch failed`）。この本文は未送信。
