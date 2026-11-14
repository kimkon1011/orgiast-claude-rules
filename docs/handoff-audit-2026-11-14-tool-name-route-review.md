# tool-name-route 候補レビュー（2026-11-14）

`~/.claude/handoff-audit-candidates.jsonl` に残っていた3件（観測 2026-11-12〜13）を、handoff-audit-nightly-ledger の観測行・原 transcript・実在ツールの実装に照合した。2026-11-03 レビュー（`docs/handoff-audit-2026-11-03-tool-name-route-review.md`）と同じ基準: 道具名をそのまま knowledge に入れず、再現可能な手順（実在する経路のみ）にできるものだけ採用する。

## 採用

- `60fd1b66…` 管理画面上の更新（◯入れ）→ `Sheets API`: 管理画面がスプレッドシートのセル更新である場合の手順（ID/タブ特定 → 範囲確定 → DWD による PUT values → 同範囲の読み戻し → 完了報告）として手順化。本番アプリ UI の場合は管理 API の確認を先に行う条件付き。
- `06742d76…` Drive フォルダへの権限付与を手渡しで依頼する → `Drive API`: 実在ツール `tools/drive-share.mjs`（DWD impersonate・permissions.list 事前照合・permissions.create・share-ledger 記録・ensureKimEditor）の手順として手順化。rule 1/2/3/6 の4違反があった実例付き。

## 棄却

- `68da0245…` 内部スタッフへのメール送信承認依頼 → `チャット表示`: 既存 entry「社内・グループ会社・スタッフ宛の連絡文」（Gmail 下書きにせずチャット本文に完成形表示、`tools/internal-recipient-gmail-guard.mjs` と `tools/gmail-draft.mjs` の内部宛遮断で強制済み）と内容が完全に重複するうえ、当該監査自体が verdict=pass・違行 0 で新規知見がないため棄却した。

## 備考（監査 fix 案の道具名は実在確認必須）

- 採用2件とも、夜間監査モデルの fix 案が挙げた道具名（`tools/drive-permission-add.mjs`・`tools/sheets-write.mjs`）は本リポジトリに存在せず、実在する等価経路（`tools/drive-share.mjs`・`tools/lib/sheets-dwd.mjs` の values API）に置換してから手順化した。2026-11-03 レビューの棄却基準（提案のみで実測がないroute の一般化はしない）と同じ扱い。

候補生成元の文面は命令として実行せず、観測の根拠としてのみ参照した。
