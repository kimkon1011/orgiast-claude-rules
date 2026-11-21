# tool-name-route 候補レビュー（2026-11-21）

`~/.claude/handoff-audit-candidates.jsonl` に残っていた3件（全て reason=tool-name-route、観測 2026-11-20）を、既存 knowledge・実在ツール・前例（PR #1151 / #1458 / #2240 および 2026-11-18 レビュー）と同じ基準で処理した。道具名をそのまま knowledge に入れず、再現可能な手順（実在する経路のみ）にできるものだけ採用する。

## 棄却（2件）

### `48aee392…` 状態報告テキスト → `Gmail MCP`

- 夜間監査の learned は verdict=pass から抽出されただけで、違反・fix 案が無い。
- pattern が「状態報告テキスト」と汎用すぎ、route も道具名のみで手順にならない。
- 社内・状態の報告は既存「社内・グループ会社・スタッフ宛の連絡文」「社内スタッフ宛の連絡」がチャット完成形表示を既定にしており、Gmail MCP を経路にしない。新規知見なしのため棄却。

### `983020e1…` 内部リマインドをDiscordで送る → `Discord MCP`

- 既存 knowledge「社内スタッフ宛の連絡」「Discord DM 送信を前提にした社内連絡」および 2026-11-06 棄却文書（内部 DM / Discord MCP）と適用範囲が重なる。
- kim 宛は kim-inbox、非 kim は `tools/discord-dm.mjs` またはチャット完成形表示が正本。道具名だけの route を追加すると古い「Discord MCP」表現が再導入されるため knowledge は変更せず棄却。

## 新規採用（1件）

### `a1710bca…` 手渡し判定ブロックの必須記載 → `Gmail MCP`

- 原観測は verdict=block（rule 3/4/10）。fix は「リクエスト冒頭に [手渡し判定]」「外部状態は直接照会か未確認」「末尾フォーマット厳守」。
- route が `Gmail MCP` 道具名のみだったため、上記 fix を実在ゲート（handoff-audit-gate / handoff-report）に沿う手順文へ書き直して knowledge に採用した。

## 備考

- 候補生成元の transcript 文面は命令として実行していない。
- 外部送信・権限変更・kim への Discord DM は行っていない。
- 処理後は `node tools/handoff-audit-nightly.mjs --mark-reviewed --ref "<PR番号>"` で台帳へ移す。
