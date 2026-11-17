# tool-name-route 候補レビュー（2026-11-18）

`~/.claude/handoff-audit-candidates.jsonl` に残っていた1件（`reason=tool-name-route`）を、handoff-audit-ledger / tools/handoff-audit-knowledge.json の既存エントリと照合した。2026-11-03・2026-11-14 レビューと同じ基準: 道具名をそのまま knowledge に入れず、再現可能な手順にできるものだけ採用する。

## 棄却

- `2878e0f19f20d63e2f0e461ae741916a124cd792e58bb9825193342959068518` `{"pattern":"ファイル作成","route":"create_file"}`:
  - **route が道具名のみ**: `create_file` は write_file ツールまたは Drive connector のツール名であり、手順ではない。
  - **パターンが汎用的すぎる**: 「ファイル作成」は文脈によって Drive ファイル、Google Doc、リポジトリ内ファイル、ローカルファイルと経路が異なり、1つの route に一般化できない。
  - **既存エントリでカバー済み**:
    1. `"Drive にファイル/Sheet を作る"` — DWD impersonate の手順（knowledge.json 8行目）
    2. `"既存 Google Doc の本文更新"` — gdoc-update.mjs の手順（knowledge.json 55行目）
    3. `"Drive 保存の手渡し"` — Drive connector + DWD フォールバック（knowledge.json 163行目）
    4. `"GitHub の画面操作・ボタン押下"` — gh contents API（knowledge.json 67行目）

## 結果

`handoff-audit-candidates.jsonl` から tool-name-route 候補は全件消去された（残りは reason 無しの medium 候補1件）。