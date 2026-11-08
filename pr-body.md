## 概要

`reopen-lost-sessions.mjs --watch`（15分監視タスク）に2つの不具合を修正。

### 問題1: 状態ベース再接続が `updated_at` の古い切断セッションを見落とす

セッション一覧の全件を `updated_at >= since`（since = watermark）で絞り込んでから状態ベースの判定をしていたため、長期間更新されていない切断セッション（例: f04d6d57, updated_at=2026-11-07T22:29, watermark=2026-11-08T10:59）が候補から除外されていた。

**修正**: 状態ベース（stateBased）では `updated_at >= since` のフィルタを適用しない。host_exit 経由の判定は従来通り絞り込みを維持。

### 問題2: 全件走査が API 期限（60秒）で打ち切られる

絞り込みを外した状態ベースで全セッション（約1000件、10ページ）をページングすると60秒のAPI期限に達して打ち切られ、watermarkが進まなかった。

**修正**:
- 降順ページングを前提に、ページの全セッションの `last_event_at`（無ければ `updated_at`）が「現在 − 72 時間」より古くなった時点でページングを打ち切る
- 状態ベース時はAPI期限を60秒から180秒に延長
- 期限切れの場合はこれまで通り candidates は処理し、watermarkは進めない

### テスト追加（全38テスト PASS）

- `state-based: updated_at が since より古くても候補になる（updated_at フィルタを適用しない）`
- `state-based: 72 時間より古いページで打ち切る（降順の場合）`

### 確認事項
- [x] `git diff --check` 通過
- [x] 全テスト PASS
- [x] 既存の `--since/--until` モードは未変更
- [x] ワークツリー外の編集なし

🤖 Generated with [Claude Code](https://claude.com/claude-code)