# Claude ペース（7日枠 90% 着地）

Claude Code の枠はアカウント単位。7日枠は 90% 着地を目標に claude-pace（毎時 OrgiastClaudePace）が管理する。

hold フラグ（`~/.claude/claude-pace-hold.json`）が立っている間は無人の追加起動をしない（対話中のセッションは止めない）。

残り10%は `config/claude-pace-queue.json` から使う。キューに社外送信を含む作業は入れない（下書きまで）。

7日枠 97% で全停止。100% 超えは起こさない。

毎朝 07:30 JST に OrgiastClaudePaceReport（担当 011、台帳が古いとき 018）がアカウント別の消費・予測着地・残り10%の作業を報告する。
