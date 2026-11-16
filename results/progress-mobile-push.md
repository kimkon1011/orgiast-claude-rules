# 進捗スマホ通知の実装結果

- PR: https://github.com/kimkon1011/orgiast-claude-rules/pull/1953
- ブランチ: progress-mobile-push（最新 origin/main から作成）
- 実装コミット: 15c50805
- 標準手順: node tools/pr-land.mjs --title "fix: 進捗の変化を毎時スマホ通知キューへ届ける" --body-file <本文ファイル>

毎時の progress-push.mjs から、進行中の有人作業がある場合のみ既存 mobile-push-queue に200字以内の1行を投入する。前回投入本文と同一なら、送信済みでも追加しない。経過時間と収集順の変化は比較対象に含めない。

auto-progress-inbox-hook の既存送信指示生成を再利用し、既存 intra-turn-progress-reminder の PostToolUse でも未送信通知を additionalContext に出す。PushNotification 送信後に mobile-push-queue.mjs --mark-sent <id> を実行する指示で、送信済み項目は再表示しない。無人セッションは消費しない。新規hookは追加していない。

## 検証

Windows / Node.js 26.13.1、次の node --test は127件中126件成功、失敗0、スキップ1（既存POSIX専用fixture）。

```powershell
node --test tools/progress-push-push.test.mjs tools/mobile-push-queue.test.mjs tools/intra-turn-progress-reminder.test.mjs tools/auto-progress-inbox-hook.test.mjs tools/progress-push.test.mjs tools/auto-progress-watch.test.mjs tools/hook-dispatch.test.mjs
git diff --check
```

有人CLIのテストでは、実行元から継承される CLAUDE_HEADLESS / ORGIAST_HEADLESS_JOB を空にし、CLAUDE_CODE_ENTRYPOINT=cli として検証した。無人抑止は独立テストで検証済み。投入、無変化抑止、作業なし、hook指示、CLI JSON出力、mark-sent後抑止を確認した。

実機スマホへの配達は未検証。PushNotificationが使える有人セッションでhookが実行された時に送信し、休止中はキューに保持するため、毎時ちょうどの実配達を保証するものではない。

ファイル削除、workflow変更、force push、他ブランチ・他PRの変更なし。既存の未追跡evidenceファイルはそのまま保持。Claude API / Discord DM の利用追加なし。
