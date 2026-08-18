# Session triage

7日以上放置のセッションは夜間バッチが非破壊で自動クローズし、引き継ぎは `~/.claude/session-handoffs.md` に蓄積する。
一覧から消えたセッションも削除されたのではなく、台帳でクローズ済みになっただけ。
`node tools/session-triage.mjs --include-closed` を付ければクローズ済みも確認できる。
