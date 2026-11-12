## 概要

セッションが「返信が届いたら」と宣言した外部チャネル（LINEグループ等）を自動照会する仕組みがなく、resumeSession の連続 timeout で沈黙していた問題を修正。

## 原因（型: 外部チャネル未監視型）

- `external-waiting.mjs` は Gmail しか監視しておらず、LINE/Discord/Beeper は未対応
- セッション e50bea8a（エイト様 LINE グループ）は「返信が届いたら」と宣言したが、auto-progress-watch は expensive な resumeSession を繰り返し、全て timeout で失敗
- 再開失敗は台帳に記録されるだけで kim-inbox に通知されず、沈黙が続いた（2026-11-12 03:58〜04:34 UTC に届いた LINE 返信を検知できず）

## 修正内容

### 1. 新規: `tools/auto-progress-external-check.mjs`
LINE グループの Supabase `channel_messages` テーブルを照会する軽量 check ツール。
- `--channel line --thread-id <groupId> --since <ISO日時>` で外部チャネルの新着を確認
- exit 0 = 新着あり（done）、exit 1 = まだ（unmet）、exit 3 = 確認不能（stalled）
- auto-progress の `--add-check` で登録可能
- 自社（direction=outbound）のメッセージは除外

### 2. 修正: `tools/auto-progress-watch.mjs`
自動再開の連続失敗（resume-failed または resume-exhausted）を kim-inbox に 🔴 で通知する。
- 3回以上の連続失敗 → kim-inbox に high priority の info として通知
- MAX_RESUMES（8回）を使い切った場合も同様に通知
- 失敗だけでなく上限到達も通知されるため、沈黙しない

### 3. 追記: `protocols/INCIDENT-TYPES.md`
「外部チャネル未監視型」を追加。

### 4. テスト: `tools/auto-progress-external-check.test.mjs`
- parseArgs のバリデーション
- Supabase からの新着メッセージ取得（モック）
- 全 exit code パターン（0/1/3）の確認

## 既存の監視との関係

- Gmail は引き続き `external-waiting.mjs` が担当（変更なし）
- LINE グループは新設の `auto-progress-external-check.mjs` を check として登録
- Discord/Beeper は未実装（check 関数のスタブのみ。今後対応）

## 登録済み監視

セッション e50bea8a のエイト様 LINE グループ（C560ba509d4d8e2b61a7646da4b55090c）に対して `auto-progress-external-check.mjs` の check を登録済み。次の watch 巡回から LINE の新着を直接照会する。