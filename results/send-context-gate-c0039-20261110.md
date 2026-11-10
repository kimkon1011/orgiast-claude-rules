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

## CI 修復と着地
- `tools/beeper-send.test.mjs`: 「相手の古いメッセージのみ」のケースに `contextAt` と履歴チェックマーカーを追加し、未定義参照を解消。
- `ONBOARDING.md` / `CLAUDE.md.template`: 既存の「kim が読むのは本当に最後のメッセージ」絶対ルールを復元。新しい送信前履歴ルールを意味を保って統合し、必須索引を 18,000 bytes 以内に維持。`node tools/render-claude-template.mjs` でテンプレートを再生成。
- Windows 該当テスト: `node --test tools/beeper-send.test.mjs tools/onboarding-sync-index.test.mjs tools/onboarding-classifier.test.mjs` 成功。追加の再現性確認 `node --test tools/rule-dedupe.test.mjs tools/onboarding-classifier.test.mjs tools/onboarding-sync-index.test.mjs` も成功。
- GitHub Actions: CI run `42723790759` の `test` 成功。test run `42723790474` の Windows `test`、`test-posix` とも成功。
- PR #1838: squash merge commit `44034ad8de30f5bee27842907656e24a9abae9d2`。
- mergedAt: `2026-11-10T00:02:34Z`（2026-11-10 09:02:34 JST）。
