# ルール遵守監査ループ

この仕組みは、ルールを文章に書くだけで終わらせず、実際の Claude Code の応答を毎晩点検します。手作業をお願いする応答は Stop hook がその場で検査し、品質上の理由、試した自動化経路3件以上、未試行経路の却下理由が揃わなければ止めます。

監査ループは直近7日分のセッションを5つのルールで数え、`~/.claude/rule-compliance.md` に遵守・違反・gateすり抜け件数を書きます。違反が3日・3件以上続けば警告からブロックへ上げ、改善すれば警告へ戻します。gateを通ったのに監査で違反だった「すり抜け」は、1件でも即ブロックです。修正案は `tools/rule-gate-patches/` に作りますが、自動適用しません。

## ルールを1件追加する手順

1. `tools/rules-registry.json` の `rules` に、重複しない `id`、出典、要約、検出条件、gate、閾値を追加します。
2. 違反文と正常文を各1件以上、`tools/rule-compliance-loop.test.mjs` に追加します。
3. 専用gateが必要なら `.mjs` を作り、`gate` にファイル名を書きます。長い本文は `~/.claude/rules/` に置きません。
4. `node --test tools/` を実行します。さらに壊したfixtureでテストが実際に落ちることも確認します。
5. `node tools/rule-compliance-loop.mjs --days 7 --dry-run` で実データを読み、誤検知がないか人が確認します。
6. レビュー後に dry-run なしで初回実行します。

自動化経路を増やしたときは `tools/automation-routes.json` の適切なカテゴリへ追加します。秘密情報は登録せず、経路名だけを書きます。
