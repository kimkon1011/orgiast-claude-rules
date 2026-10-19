【PR #817 結果: 既にマージ済み（冪等チェックで終了・追加操作なし）】

実行コマンドと出力（kim-PC, 2026-10-20 実測）:

1) gh api user --jq .login
   → kimkon1011

2) gh api repos/kimkon1011/orgiast-claude-rules/pulls/817 --jq "{merged, state, sha, merge_commit}"
   → {"merge_commit":"d93767e0dca95d2ed41e192f19cd0dbc6cc0ff98","mergeable_state":"unknown","merged":true,"sha":"34d12c22f765c7b09e4187b6b32b6abcbd6b085f","state":"closed"}
   merged_at=2026-10-16T16:51:20Z / merged_by=kimkon1011

3) gh api repos/kimkon1011/orgiast-claude-rules --jq .permissions
   → {"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}

4) git grep -n list_triggers origin/main -- tools/remote-trigger.mjs
   → 1件のみ: tools/remote-trigger.mjs:7 「// list_triggers / get_trigger / update_trigger は存在しない値で、渡すとツール側が…」
   ※ 誤値を使わないよう注意するコメント行で、実コードの action 値ではない（#817 適用前の2件から減少）。

結論: merged=true のため完了条件を満たしている。PUT merge は実行していない（不要）。パッチ・ブランチ作成もなし。
