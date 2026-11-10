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

## PR #1838 実地不具合の修正（2026-11-10）
- LINE の `channel_messages` を `select=*`・1件で実地確認し、実列が `sender_display_name` であることを確認。存在しない `sender_name` を選択していたクエリを修正した。
- LINE・Gmail・Discord の履歴取得失敗時に、HTTP ステータスだけでなくレスポンス本文も表示するようにした。
- Gmail の実地検証で、GWSプロキシ用マーカーを通常の `fetch` へ渡して HTTP 401 になる問題を確認。既定の取得関数を `gwsFetch` に統一して修正した。
- Gmail の長い引用履歴をWindowsのコマンドライン引数へ載せるとLLM判定プロセスを起動できない問題を確認。プロンプトを一時ファイルに置き、`llm-ask.mjs --prompt-file` で渡すようにした。
- モックを実列 `sender_display_name` に合わせ、HTTP 400本文、GWS経路、Windows引数長回避を回帰テストに追加した。

### Windows 実データ確認（送信なし）
- LINE `C10930732da844f79c6032a40705a4d73`: 履歴8件を表示し、未回答事項を検出して `NG`。HTTP 400 は解消。
- Gmail thread `19fcaf3ba4f2ccba`: 履歴4件を表示し、テスト本文を `OK` 判定。
- Discord channel `1382752379488833620`: 履歴100件を表示し、テスト本文を `OK` 判定。
- いずれも `send-context-check.mjs` の読み取り・判定だけを実行し、送信処理は実行していない。
