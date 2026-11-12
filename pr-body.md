## 問題

`gmail-connector-url-gate` と `mail-send-approval-gate` が相互ブロックし、承認済みの社外メール（Meet URL 入り）を送信する経路が消えていた（2026-11-12 実測）。

- gmail-draft.mjs で下書きを作成（URL は正しい）
- send_message に body を渡す → url-gate が URL を理由に deny
- send_message に draftId だけ渡す → mail-send-approval-gate が body 無しを CONTEXT_REASON で deny
- 両方を満たす経路が存在しない

## 修正

**tools/gmail-connector-url-gate.mjs**: `send_message` に空でない `draftId` が指定されている場合、Gmail コネクタは既存下書きをそのまま送信し（subject/body/htmlBody を無視）、URL 書き換えが起きないため pass させる。

**tools/gate-remedies.md**: draftId 送信時の回避策を追記。

**protocols/INCIDENT-TYPES.md**: 型「ゲート間相互ブロック型」を追記。

## 検証

`node --test tools/gmail-connector-url-gate.test.mjs tools/mail-send-approval-gate.test.mjs` → 37件全件 pass。

新規テストケース（11件）:
- draftId + URL body → pass（要修正）
- draftId なし + URL body → block
- create_draft の URL body → block（draftId 相当の引数があっても）
- update_draft の URL body → block
- reply/forward の URL body → block
- 空 draftId → block
- 非 Gmail ツール → pass
etc.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
