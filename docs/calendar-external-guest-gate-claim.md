# 社外カレンダー招待の禁止

- 着手: 2026-11-17 / Codex
- 作業場所: wt-cal-guest-gate / feat/cal-guest-gate
- 範囲: ゲート・converge 登録・自動返信ガード・テスト。commit/push/本番送信なし。
- main 取り込み: git fetch origin main が Git 管理領域の read-only により失敗。
- 状態: 実装・ローカル検証完了。全PCへの配布は未実施。
- 指定テスト: 234件 / 成功232 / 失敗0 / skip2（既存Windows専用）。
- 配布登録検証: register-hooks clean-profile 1件成功（新規必須ゲートを含む）。
- 実害文面: Discord/Beeper双方で1回再生成、再度禁止なら送信0・kim-inbox askを確認。
