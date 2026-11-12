# Discord 自動返信の実装・検証（2026-11-12）

kim 承認の `autoreply-decision` / `autoreply-sent` だけを Bot DM に配送する。代理返信全文は書き換えず2000 UTF-16文字以内に分割し、失敗は kim-inbox に保存する。他の通知カテゴリと MCP 直接送信ゲートは制限を維持する。

DM・グループDM は Beeper の kim Discord アカウント専用。既読も取得し、FYI は返信しない。判断待ち・未承認リクエスト・初対面・添付確認・読取不明は送信しない。送信前後の再確認、永続台帳、送信試行の1回5件・1時間30件制限を実装した。サーバーと共通の他AI分類を使い、返信先頭は `【AI自動返信】`。

## 作業領域

- `/mnt/c/Users/uers/.claude/nightly-repo/.wt/autoreply-kim-dm-20261112c`
- ブランチ: `feat/autoreply-kim-dm-20261112c`
- ベース: 作業開始時の `origin/main` = `a00e818ca169a0c5908e2519e6493f508946503c`
- 親 `.git` が sandbox 上で読み取り専用のため `git worktree add` は失敗。指定 b の登録も Windows 形式だった。既存 worktree を変更せず、上記パスに WSL Git の独立 shared clone を作成した。origin は元リポジトリと同じ upstream に設定。
- 本番チェックアウト、旧 worktree、他セッションの差分、既存のタスク登録には触れていない。push していない。

## 検証

Windows Node (`C:\Program Files\nodejs\node.exe`) で関連15ファイル、**252 pass / 0 fail**。Discord/Beeper への POST と Bot DM はモックのみ。

最終実行は `--test-concurrency=1`。並列再実行で既存の HTTP 期限テストが1回 `ABORT_ERR` になったため、条件を緩めず逐次で全件を再検証した。

対象は discord-autoreply、discord-beeper-autoreply、discord-dm-drafts、notify-kim、notify-kim-quota-sweep、kim-dm-policy、kim-discord-report-gate、kim-discord-dm-ban、beeper-api、beeper-send、beeper-unreplied、kim-no-dm、kim-discord-allowlist、owner-dm-policy、owner-dm-digest-regression の各 test.mjs。

- サーバー `node tools/discord-autoreply.mjs once --dry-run`: `ok=true`、scanned=125、replied=0、errors=[]。処理台帳は更新せず、送信・通知なし。
- Beeper 全会話 `node tools/discord-beeper-autoreply.mjs once --dry-run`: `ok=true`、scanned=91、判断待ち=55、wouldSend=0、replied=0、errors=[]。検証用 preload で Discord/Beeper の GET 以外を拒否し、69 GET / 送信系呼び出し0を確認。実機の Beeper 処理台帳が作成されていないことも確認。
- 対象2会話を実機 API から読んだ dry-run: `ok=true`、送信0、wouldSend=[]、errors=[]。
- chat 828、11/12 10:54 白石さんの検品・請求金額確認: **判断待ち（kim の判断が必要）**。既読でも取得できる。
- chat 1426、浅沼憲一郎さん: **判断待ち（メッセージリクエスト・未承認）**。API の `capabilities.messageRequest` を確認。
- `getChat`、`listChats`、`listMessages` の戻り値では native Discord channel/message ID、Beeper deeplink を取得できなかった。Matrix room ID と Beeper ローカルIDを Discord ID と誤認せず、今回は会話名にフォールバックする。
- `register-discord-beeper-autoreply.ps1`: PowerShell パーサーで構文 OK。登録・起動は未実行。優先度4、5分ごと、run-hidden 経由。
- 配布文書の旧記述の除去: 4 assertions 成功。`claude-md-legacy.json` の「全廃・例外なし」は旧文を照合して除去するためだけに残し、新しい例外規定が存在する場合に移行する。
- `docs/org-instructions.md`: **2528字**（Unicode コードポイント、LF）。他の条項を削っていない。
- `git diff --check`: 成功。

## 運用上の扱い

送信後の読み戻し失敗は、既に送信された可能性があるため `uncertain` にして再送しない。通知の失敗は返信処理を停止させず、Beeper の通知 outbox を次回に持ち越す。異常終了後の lock はプロセス停止を確認してから除去する。旧 UI Automation タスクは運用切替時に停止する対象であり、この変更では削除していない。

## 変更ファイル一覧（23件）

- `CLAUDE.md.template`
- `ONBOARDING.md`
- `docs/kim-editor-no-dm-claim.md`
- `docs/kim-inbox.md`
- `docs/org-instructions.md`
- `protocols/INCIDENT-TYPES.md`
- `tools/beeper-api.mjs`
- `tools/claude-md-legacy.json`
- `tools/discord-autoreply.mjs`
- `tools/discord-autoreply.test.mjs`
- `tools/discord-dm-drafts.README.md`
- `tools/kim-discord-report-gate.mjs`
- `tools/kim-discord-report-gate.test.mjs`
- `tools/lib/kim-discord-allowlist.mjs`
- `tools/lib/kim-dm-policy.mjs`
- `tools/lib/kim-dm-policy.test.mjs`
- `tools/notify-kim.mjs`
- `tools/notify-kim.test.mjs`
- `playbooks/discord-beeper-autoreply.md`
- `tools/discord-beeper-autoreply.mjs`
- `tools/discord-beeper-autoreply.test.mjs`
- `tools/register-discord-beeper-autoreply.ps1`
- `docs/discord-autoreply-20261112-validation.md`
