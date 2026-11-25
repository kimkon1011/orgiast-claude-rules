# PR #1799 送信承認ゲート誤検知の修正結果

## 真因

`tools/mail-send-approval-gate.mjs` の `sendTargets()` が、シェル区間内の全引数から送信 CLI 名を検索していた。そのため、送信 CLI を実行していなくても、grep の引数、ヒアドキュメント本文、import 文に `line-group-send.mjs` などの文字列が含まれるだけで送信と誤判定していた。

## 変更ファイル

- `tools/mail-send-approval-gate.mjs`
  - 直接起動されたスクリプト、または `node` のエントリースクリプトだけを送信 CLI と判定するよう変更。
  - `--dry-run` の許可を維持。
- `tools/mail-send-approval-gate.test.mjs`
  - ヒアドキュメント内の import と読み取り専用スクリプト実行を許可する回帰テストを追加。
  - `ls` / `grep` の引数に送信 CLI 名が含まれるケースを許可する回帰テストを追加。
  - `node tools/line-group-send.mjs --group X --text-file f` の実送信が拒否される回帰テストを追加。

## PR URL

https://github.com/kimkon1011/orgiast-claude-rules/pull/1807

## テスト結果

- `node --test tools/mail-send-approval-gate.test.mjs`: 25件成功、失敗0件。
- `node --test tools/register-hooks.test.mjs`: 28件成功、失敗0件。
- `node --check tools/mail-send-approval-gate.mjs`: 成功。
- `git diff --check`: 成功。

指定ケースの判定結果は、読み取り専用2件が `pass`、実送信が `block`、LINE の `--dry-run` が `pass`。
