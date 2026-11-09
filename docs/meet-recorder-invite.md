# Meet 録画招待の自動追加

`tools/meet-recorder-invite.mjs` は kim@orgiast.jp の primary カレンダーを監視し、tl;dv 録画ボット（seisaku-team@orgiast.jp）が招待されていない Meet 予定に自動で招待を追加する。

## 目的

tl;dv の録画ボットは seisaku-team@orgiast.jp のカレンダーに載っている Meet にだけ参加する。kim が主催する Meet に seisaku-team が招待されていないと録画が残らない。このツールは kim の予定のうち録画対象の Meet に seisaku-team を自動追加する。

## 対象条件（すべて満たすもの）

- キャンセルされていない
- Google Meet のリンクがある（`hangoutLink` または `conferenceData`）
- kim が主催（`organizer.self === true`）
- 公開範囲が `private` / `confidential` でない
- 題名・説明に `録画不要` / `録画しない` / `no-record` を含まない
- 参加者に seisaku-team@orgiast.jp がまだいない
- 参加者に kim と会議室リソース以外の人がいない場合、題名が `M：` または `M:` で始まるものだけ対象（例: 「M：エイト」は対象、「マハタパスサダナ」は対象外）
- 参加者に kim と会議室リソース以外の人が1人以上いる場合、orgiast.jp 以外のドメインの人が1人以上いるときだけ対象（社内だけの会議は対象外）

## 動作

- 今から14日先までの予定を全ページ取得
- 対象に `PATCH events/{id}?sendUpdates=none` で attendees に seisaku-team@ を追加（既存の attendees は全部そのまま）
- PATCH 後に GET で読み戻し確認、入っていなければ失敗として記録
- 結果を `~/.claude/logs/meet-recorder-invite.jsonl` に JSON Lines で追記
- 失敗が1件でもあれば exit 1

## 実行

```sh
# 確認のみ（変更しない）
node tools/meet-recorder-invite.mjs --dry-run

# 確認期間を指定（既定14日）
node tools/meet-recorder-invite.mjs --dry-run --days 7

# 本番実行
node tools/meet-recorder-invite.mjs
```

## タスク登録

Windows タスク `OrgiastMeetRecorderInvite` が30分ごとに非表示起動する。

```powershell
powershell -File tools/register-meet-recorder-invite-task.ps1 -Ensure
```

## 停止方法

- 予定の題名に「録画不要」「録画しない」「no-record」を含める（個別停止）
- タスク削除: `powershell -File tools/register-meet-recorder-invite-task.ps1 -Remove`
- タスク削除だけでは converge で復活するため、恒久停止は別途対応が必要

## ログ

`~/.claude/logs/meet-recorder-invite.jsonl` に1行ずつ追記される。各エントリには実行時刻・対象件数・追加件数・失敗件数・各予定の ID/開始時刻/題名が含まれる。