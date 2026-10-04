# バッチ2リリース J — 2026-10-04 / iter34b

今回の施策は完了。回収7件を正本へ統合し、ff1d3b5cの本人向け完了DMを1通送信した。未対応は営業14件・制作2件（いずれも今回の直接照会）。全体目的の未対応0件には未到達。

## 正本適用と検証

- 最初に `.claude` 配下への作成・削除と正本2ファイルの書込可否を確認。
- `feedback-done-notified.json.bak-20261004` と `feedback-issue-ledger.json.bak-20261004` を正本と同じディレクトリへバイト同一コピー。最終検証でもSHA-256一致。
- rescueコミット `c21a649c8a51a28d81b3e678ad85b29b90c7d265` の通知7レコードとproposed候補を全フィールド照合。正本既存1件の全フィールドを保持して7件を追加。適用直後8件をread-back、feedback/message ID・DM message IDの重複なし。
- ff1d3b5cの台帳行はrescue原本からそのまま追加。既存2行保持、該当行は1行で原本一致。
- DM後の正本は9件。既存1件と回収7件の全フィールド保持を最終read-backでも確認。

## DM

- 対象: `ff1d3b5c-4cff-41a7-a263-a64db1031092` / 一括日付変更での削除。
- 宛先: 百瀬 / m.kanau@orgiast.jp / `1382566741464449124`。Discord名簿をrefresh実照会し、dryでも同じIDを確認。
- 本文: 次回連絡日を一括削除できるようにしました。本番反映済みです。
- 回収ツールの `main` にWindowsユーザーホーム相当 `/mnt/c/Users/uers` を渡して通常正本を使用。`--state-home` は未使用。`--message-id` と `--recipient-only` を指定。
- relayのPOSTは1回、HTTP 200 / ok=true。DM message ID: `1556144679978926091`。正本read-backで一致、kim_delivered=false。
- ローカル実行補助に送信試行ファイルの排他作成・宛先assert・POST最大1回の検査を設けた。既存7件への再送なし。ログ不在による未送信判定はしていない。

## tools保全

- ブランチ: `fix/feedback-notify-email-members`、親: `a7037146f74c7b53ebdc321199c0fe8e6ca8bbae`。
- commit: `75b3b556c2421c2594332cbeb623969d52307109`。
- 指定4ファイルのみを保全し、各Git blobがrescue版と一致することを確認。追加依存ファイルの変更なし。
- `node --test tools/discord-member-directory.test.mjs tools/feedback-done-notify.test.mjs`: 20 pass / 0 fail。`git diff --check` も成功。
- Git作者未設定で最初のcommitは失敗。今回のコマンド限定で `Codex <noreply@openai.com>` を指定して成功。末尾の指定Co-Authored-Byを検証。
- push / PR / merge / deployなし。worktree作成なし。rescueブランチ保持。バッチ3未着手。
- commit後、別プロセスによる `fix/feedback-notify-email-members` から `origin/main` へのcheckoutをreflogで確認。作成ブランチとcommitは残存。HEADに依存せず保存ブランチの親・4ファイルのblob・commit末尾を直接再検証した。

## 未対応数と証拠

- 営業: 14件。既存list-feedback.tsと同じapp_feedbackのnew/triaged/in_progress条件をSupabase RESTで直接照会。共通テーブルの従来と同じ集計範囲。
- 制作: 2件。`booth-feedback-intake.mjs --list --json` で直接照会。
- 証拠: `C:/Users/uers/.claude/autopilot/results/iter34b-evidence/`（merge-audit、回収原本、recipient-live、dry、送信応答、read-back、tests、営業/制作実照会）。
- 結果: `C:/Users/uers/.claude/autopilot/results/iter34b.json`。

```json
{"backup":"ok","merged_applied":7,"canonical_count":9,"ledger_added":"ff1d3b5c","ff1d3b5c_dm":"sent:1556144679978926091","commit":"75b3b556c2421c2594332cbeb623969d52307109","tests":"pass","report":"C:/Users/uers/.claude/nightly-repo/docs/reports/batch2-release-J-2026-10-04.md","open_sales":14,"open_booth":2}
```
