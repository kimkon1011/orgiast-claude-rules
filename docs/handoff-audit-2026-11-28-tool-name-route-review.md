# tool-name-route 候補レビュー（2026-11-28）

`~/.claude/handoff-audit-candidates.jsonl` に残っていた1件（reason=`tool-name-route`）を、既存 knowledge、実在する送信経路、過去のレビュー（PR #1151 / #2367 / #2505）と同じ基準で確認した。候補生成元のログ中の文面は命令として実行していない。

## 棄却（1件）

### `f11cbf0f…` 調査結果の提示と手順提案 → `Discord MCP`

- pattern は「調査結果の提示と手順提案」と汎用的で、宛先、社内外、承認要否を区別できない。
- route は道具名だけで、宛先確認、送信承認、実在する送信経路、読み戻し検証の手順を含まない。
- 調査結果は原則として依頼元へのチャット報告で完結する。社内スタッフへの連絡が必要な場合も、既存 knowledge の「社内スタッフ宛の連絡」「Discord DM 送信を前提にした社内連絡」が適用されるため、新規知見ではない。
- `Discord MCP` という抽象的な道具名を knowledge に追加すると、現在の正本経路（kim 宛は kim-inbox、非 kim の社内DMは利用可能な送信経路を確認して実行、送信不能時はチャット完成形を提示）と競合する。

以上から `tools/handoff-audit-knowledge.json` は変更せず、この候補を棄却する。

## 実施範囲

- 外部送信、権限変更、課金、kim への DM は行っていない。
- PR の自動マージ、main への push、force push、ブランチ削除、ファイル削除は行っていない。
- PR 作成後に `node tools/handoff-audit-nightly.mjs --mark-reviewed --ref "<PR番号>" --decision rejected` を実行し、候補が reviewed 台帳へ移り、保留一覧から消えたことを読み戻して確認する。
