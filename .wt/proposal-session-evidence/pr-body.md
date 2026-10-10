自動提案が Discord DM で止まっていたため、採用案・根拠・変更内容・費用効果と承認手順を次の Claude Code セッションへ登録します。model-scout は eval 済みでカテゴリ別合格率が現行比 −3pt 以内、入力/出力の単価が両方同額以下かつ一方以上安い候補だけを提案します。cost-improve は人へ上げる項目を日次1件にまとめ、未処理があれば追記します。

## 実装と変更ファイル

- `tools/proposal-session.mjs`: JSON/Markdown/生成指示書の保存、FIFO、既存 next-session 本文保持、kim-PC のみ既存起動経路呼び出し、1行DM、dry-run、完了時の done 移動。ID検証・キューロック・重複抑制・追記時revision照合・通知失敗の再試行。
- `tools/proposal-session.test.mjs`: 保存、既存引き継ぎのbyte単位保持、FIFO、dry-run無副作用、機体制限、1行DM、通知障害、生成元接続、日次上限、追記後の古い承認拒否。
- `skills/session-start/SKILL.md`: 1提案だけ提示し、承認→codex-do→検証→PR→pr-merge→done、却下理由保存の監督手順。
- `tools/model-scout.mjs`: 既知候補のeval完了も検知、品質・単価を比較し提案とCodex指示書を生成。未評価は「評価中」。月額は利用量未集計なら未算定。
- `tools/eval-harness.mjs`: `--all` 完了時、既存 routing-table 再生成前に保存済み候補から提案を登録。
- `tools/cost-improve-loop.mjs`: human項目を共通経路へ登録、登録失敗を状態に残して次回再試行。
- `tools/cost-improve-loop.test.mjs`: 本体からの接続をモック検証。

## 調査した実在の導線

| 用途 | ファイル・関数・形式 | 今回の利用 |
|---|---|---|
| 最初の文脈 | `skills/session-start/SKILL.md` 手順1、`skills/session-close/SKILL.md` 手順6。`~/.claude/next-session.md` の NEXT-SESSION v1 と「次の1目的」等 | 全文Markdownと承認案内を専用ブロックで先頭登録。既存本文をそのまま保持 |
| VS Code Claude Codeタブ | `tools/next-session-launch.mjs`: `launchNextSession` → `planVscodeLaunch` → `buildVscodeUri` → code CLI `--open-url`。既存 `tools/close-session.mjs` も利用 | `--target vscode --prompt /session-start`、`fleet-mail.mjs` の `resolveFleetLabel(home)` が `kim-PC` の場合だけ呼ぶ |
| 自動送信の制限 | 同ランチャーの vscode 経路は入力欄へ置くだけ | Enter 1回が必要。自動送信完了・実タブ起動実測とは報告しない |
| 他の既存起動 | `next-session-launch.mjs` の `planVscodeExtLaunch` は統合ターミナル。`session-relaunch.mjs` の `armToFile` は inline の /clear 後の開始予約 | 今回は利用しない |
| 停滞再開 | `tools/stalled-session-resume.mjs` の `execute` → `auto-session.mjs` の `runChild`（既存session IDをresume）。`register-stalled-session-nightly.mjs` の `main` はPS1タスク登録 | 新しいVS Codeタブを作る導線ではない |
| Remote Control | `tools/setup-manifest.json` の `settings:remote-control-at-startup`、`tools/register-hooks.mjs` が `remoteControlAtStartup=true` を設定 | 開始済みセッションの設定。新タブ・最初のプロンプトの生成経路としては使わない |
| autopilot | `tools/autopilot-tick.mjs` の `autopilotPaths` / `runAutopilot` / `execute`。`start --objective` で `~/.claude/autopilot/objective.md` のJSONとstateを作成可能。自動補充元は `next-actions.md` | 未承認提案を投入すると実装が始まるため使わない。提案FIFOを別途保持 |
| eval・routing | `eval-harness.mjs` の `resultRecord` / `runOne` が `~/.claude/eval-results.jsonl` に provider/model・byCategory を追記。`--all` 後 `routing-table.mjs` の `rebuildRoutingTable` が生成 | `aggregateMeasurements` のカテゴリ別実測を比較。既存のルーティング自動再生成の挙動は維持 |

## 検証

指定どおり `.wt/proposal-session-clone` を `git clone --no-checkout` し、`origin/main` (3e7c513) 起点の `.wt/proposal-session` / `feat/proposal-session-20261009` で作業。元ツリーの既存差分は変更していません。

```
node --test tools/proposal-session.test.mjs tools/model-scout.test.mjs tools/cost-improve-loop.test.mjs tools/eval-harness.test.mjs tools/routing-table.test.mjs tools/next-session-launch.test.mjs
ℹ tests 176
ℹ pass 176
ℹ fail 0
```

- `git diff --check`: exit 0
- skill-creator の `quick_validate.py skills/session-start`: `Skill is valid!`
- 本変更に生成docはありません。
- 実タブ起動・実DM送信・本番提案保存は未実施（指定された dry-run とモック検証）。既存ランチャーの抑止条件・停止設定は維持しています。

## このPCの dry-run stdout（全文）

WSL から kim-PC のホームを明示して実行（`ORGIAST_HOME=/mnt/c/Users/uers`）。サンプルは動作確認用で、実モデルの評価結果を偽造していません。

```
node tools/proposal-session.mjs --dry-run --file ../proposal-session-evidence/sample.json
[dry-run] 実装提案セッション: 要約モデルの採用提案（動作確認）
保存予定: /mnt/c/Users/uers/.claude/proposals/proposal-session-sample.{json,md}
導線: next-session.md の先頭（既存本文を保持）
提示順: 要約モデルの採用提案（動作確認）
起動: launchNextSession --target vscode（Enter 1回が必要）

# 要約モデルの採用提案（動作確認）
提案ID: proposal-session-sample / 生成元: model-scout

## 提案
評価後の採用案をセッションで判断する

## 根拠
- サンプル: 候補97%、現行100%（実測採用案ではありません）

## 変更内容
- tools/routing-table.json
  変更前: 現行モデル
  変更後: 評価済み候補

## 費用効果
月額効果: 未算定
月間トークン数未集計のため未算定

## リスク
- 評価対象外の品質差

## 承認するとどうなる
onApprove: codex-task / 指示書: ~/.claude/proposals/proposal-session-sample.codex.md
Codex が実装・関連テスト・PR作成を行い、監督が検証して tools/pr-merge.mjs でマージします。

## 却下するとどうなる
現行モデルを維持する

承認なら「承認」、却下なら「却下 <理由>」と答えてください。承認で Codex が onApprove の指示書を実行し PR→pr-merge まで進めます

DM予定: 実装提案セッションを用意しました: 要約モデルの採用提案（動作確認）（次に Claude Code を開くと先頭に出ます）
```

## 今日の候補4件

kim-PC の `~/.claude/eval-results.jsonl` を直接照合:

```
anthropic/claude-haiku-5.5: eval行 0
anthropic/claude-haiku-5.5:batch: eval行 0
apodex/apodex-1.1-mini:free: eval行 0
inclusionai/ling-3.1-flash: eval行 0
```

実PCの生成済み `routing-table.json` を隔離ツリーのgitignore対象へコピーして比較に使用（コミット対象外）。`ORGIAST_HOME=/mnt/c/Users/uers node tools/model-scout.mjs --dry-run` の stdout:

```
eval 未了のため提案なし
```

このPRは作成まで。依頼に従いマージしません。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
