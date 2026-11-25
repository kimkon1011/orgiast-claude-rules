# kim-inbox マージ可否 ask 防止 作業結果

## 実装コミット

`fea6f4ba59057c5c85b78a0150d4ddd5f8186495`

## 変更ファイル

- `ONBOARDING.md`
- `protocols/INCIDENT-TYPES.md`
- `test/kim-inbox-autoclose.test.js`
- `tools/kim-inbox-autoclose.mjs`
- `tools/kim-inbox-kind.test.mjs`
- `tools/kim-inbox-relay.test.mjs`
- `tools/kim-inbox.mjs`
- `tools/lib/kim-inbox-brief.test.mjs`
- `tools/lib/kim-inbox-merge-handoff.mjs`
- `tools/lib/kim-inbox-relay-state.mjs`

## 追加・更新した回帰テスト

- `isPullRequestMergeApprovalRequest: マージ可否の依頼だけを検出する`
- `--add ask は PR のマージ可否依頼を拒否して exit 2`
- `--merge-handoff-ok は例外理由を記録してマージ可否 ask を許可する`
- `PR を含む ask も返事の例をマージ可否に変えない`
- `MERGED 済み PR のマージ承認 ask は対象`
- `マージ以外の承認待ちは PR が MERGED 済みでも対象外`
- `CLOSED だが未マージの PR のマージ承認 ask は対象外`
- `info with extracted decide gets reply options instead of 返事不要` の期待値を通常の返事例へ更新

## テスト実行結果

実行コマンド:

```powershell
$env:CLAUDE_CODE_ENTRYPOINT=''; node --test "tools/kim-inbox*.test.mjs" "tools/lib/kim-inbox*.test.mjs" "test/kim-inbox*.test.js"
```

実出力の集計:

```text
ℹ tests 240
ℹ suites 3
ℹ pass 240
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21320.1627
```

`git diff --cached --check`: exit 0（出力なし）。
