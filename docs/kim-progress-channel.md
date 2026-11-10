# kim 宛進捗通知チャネル統一仕様

## 1. 原則と目的
- **Discord 通知の全廃**: kim 宛のすべての通知（進捗まとめ・完了通知・判断待ち・配送警告・社外返信待ち）は Discord へ一切送信しない（例外なし）。
- **セッション内 1 画面集約**: すべての通知は `kim-inbox` にのみ集約し、SessionStart / UserPromptSubmit で 6KB 以下の 1 画面コンパクト表示を行う。
- **全 PC・全環境共通化**: 全 PC / 全アカウント / 全 CLI セッションで統一挙動とし、Discord へ戻す変更は CI / テストで自動ブロック（停止）する。

## 2. 配送ポリシー
1. **kim 宛通知の届先**: `kim-inbox`（`~/.claude/kim-inbox.json`）のみ。
2. **許可リスト (`config/kim-discord-allowlist.json`)**: `entries: []` を維持する。許可エントリーの追加は禁止。
3. **朝の進捗まとめ (auto-progress-digest)**:
   - 各席からのダイジェストは Discord ではなく kim-inbox に積む。
   - 1 日 1 件（`auto-progress-daily:<YYYY-MM-DD>`）に `replaceExisting` / `dailyProgress` 機構で統合し、他席から fleet 経由で届く分も同一日付キーに集約・更新する。
4. **完了通知 (auto-progress-done-inbox)**:
   - `mirrorToDiscord` 処理を全廃し、kim-inbox への記録のみ行う。

## 3. kim-inbox セッション注入（1 画面・6KB 上限）
SessionStart / UserPromptSubmit フックにおいて、以下フォーマットで 6KB 以下に収まるよう切り詰めて表示する:

```text
【進捗まとめ】
■ 判断待ち（上位 5 件）
・[ask-id] <件名>: <概要 1-2 行> (決定内容)
...

■ 完了（昨日〜今日、最大 5 件）
・[席名] <案件名> (完了時刻)
...

■ 止まっている（最大 3 件）
・[task-id] <件名> (原因: <エラー概要 1行>)
...

■ 件数
ask: N件 / info: N件 / 返事待ち: N件
(詳細・全件閲覧: node tools/kim-inbox.mjs --list --open)
```

### 止まっている（エラー検出・未達）
- auto-progress の check 実行時、stderr にエラー語（`hub不達`, `timeout`, `EBUSY`, `403` 等）が **2 回連続** して記録された check 項目は、「止まっている」欄に要因（`原因: <stderr 1行>`）と共に表示する。

## 4. unregistered-promise-gate (セッション内待機約束の防止)
- 応答テキストの「この後の自動進行」等において、「このセッションで」「1分ごと」「バックグラウンドで確認」などのセッション依存待機を宣言している場合、対応する `--add-check` 行が自動進行台帳に登録されていなければ Stop ゲートでエラーとして差し戻す。
- これにより、セッション終了時にタスクが放置される事態を防止する。
