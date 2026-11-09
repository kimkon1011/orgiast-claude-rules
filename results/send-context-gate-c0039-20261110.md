# C0039 送信前履歴整合性ゲート

## 真因
送信承認が本文とだけ結び付いており、宛先の最新履歴・自社既送信・チェック後の新着と結び付いていなかった。そのため、古い自動進行の約束が、回答済み質問と未回答要望を確認せず再送できた。

## 変更ファイル
- `tools/send-context-check.mjs` / `tools/lib/send-context.mjs`: LINE・Gmail・Discord・Beeper の30日または最低20件の履歴、自社送信ログ、安価LLM判定、本文SHA-256マーカー。
- `tools/line-group-send.mjs` / `tools/gmail-draft.mjs` / `tools/discord-dm.mjs` / `tools/beeper-send.mjs`: 実送信直前に本文・宛先・30分・最新ID/時刻を再検証し、送信後ログを記録。dry-run、kim-inbox は除外。
- `tools/mail-send-approval-gate.mjs`: hook を通る経路でも履歴チェックマーカーを要求。読み取りコマンドは対象外。
- `ONBOARDING.md` / `CLAUDE.md.template` / `protocols/INCIDENT-TYPES.md`: 全PC共通ルールと「送信前履歴未読型」を追加。
- `tools/send-context-check.test.mjs` ほか関連テスト。

## PR
PR URL: https://github.com/kimkon1011/orgiast-claude-rules/pull/1838

## テスト結果
- `node --test tools/send-context-check.test.mjs tools/mail-send-approval-gate.test.mjs tools/gmail-draft.test.mjs tools/line-group-send.test.mjs`: 78件成功、失敗0件。
- 回答済み質問の再送→NG、マーカー無し→拒否、チェック後の新着→拒否、OKマーカー＋最新一致→許可、Beeper dry-run→許可を確認。
- `git diff --check`: 成功。

## 配布経路
送信CLIとhookは rules repo の通常配布対象。`mail-send-approval-gate` は `tools/hook-dispatch-manifest.json` と `tools/setup-manifest.json` の既存 `settings:mail-send-approval-gate` 修復経路に載っている。ルールは onboarding-sync、hook登録は `setup --converge` で全PCへ反映される。
