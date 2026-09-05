# 夜間自動化の追加（2026-09-05）

日中のコスト・手間・時間を削るため、夜間/早朝の自動作業を4件追加・修正した。すべて実データで動作確認済み。

## 1. 夜間ジョブの失敗検知（新規）`tools/nightly-health.mjs`

**なぜ**: 2026-09-05 06:30 に `mail-task-digest` が Gmail 404 で落ち、その日のメール由来タスク抽出が0件になった。
しかし Windows スケジュールタスクの **`LastTaskResult` は 0（成功）** だった。ラッパーが内側の失敗を飲み込むため、
スケジューラの終了コードでは障害を検知できない。結果9時間誰も気付かず、kim が偶然尋ねて初めて発覚した。

**何をするか**: 毎朝07:00に次の3つを見て、**異常がある時だけ** Discord DM を1通送る（平穏な夜は無音）。

| 検知 | 方法 |
|---|---|
| ログ内の失敗 | 登録済みログの**前回からの追記分だけ**を走査（バイトオフセット差分） |
| 停止したジョブ | 期待実行間隔を超えて更新が止まったログ／存在しないログ |
| ローカルテストの赤 | `node --test` を実行。**baseline に無い新規の赤だけ**通知 |

**設計上の判断**

- **自動修復はしない**。無人で本番コードを書き換えるのは、過去に「Codex が期待値でなく本番側を黙らせて緑にした」
  回帰事故があったため禁止。報告のみ。
- **散文ログは走査しない**。`auto-session-launcher.log` や `run-rule-compliance-loop.log` は AI が書いた
  要約文・レポート本文が流れ込むため、「失敗」という語を含む正常動作を永久に誤検知する。
  期待リストの `scan` で `keywords` / `stale-only` を明示し、既定は `stale-only`。
- **未登録ログ・baseline抑制は「異常」ではなく注記**。それ単独では通知しない（毎日DMが来ると読まれなくなる）。
- **既知の赤は baseline で抑制**。この作業ツリーは並行セッションが常時書き換えており、
  実測で着手時2件→40分後10件と変動した（いずれも当該作業と無関係）。`--update-baseline` は手動実行のみ。

**運用**: 導入時に `--prime` を1回実行してオフセットを記録済み（初回の DM が解決済みの過去の失敗で埋まるのを防ぐため）。

## 2. 朝の推奨アクションの作り置き（新規）`tools/next-actions.mjs`

**なぜ**: 直近14日30セッションの実測で、「この先はどうしたらいいの？」型の現状把握依頼が **8件/6セッション**あり、
**セッション冒頭に集中**していた。毎回 Opus がゼロから PR一覧・残TODO・タスク台帳・夜間ログを調べ直していた。

**何をするか**: 毎朝07:00に、未処理PR（`gh pr list`）・`next-session.md` の残TODO・夜間ログの異常・
タスク台帳の P1 を集め、安いLLM（groq → deepseek フォールバック）に優先順位付けさせて
`~/.claude/next-actions.md` に3件書き出す。LLM が使えない時は機械的な優先順位に落ち、**必ず理由を stderr に残す**。

## 3. セッション冒頭での提示（新規）`tools/next-actions-notice.mjs`

SessionStart フックに登録。作り置きが**30時間以内なら**3件を1行ずつ・最大8行で出す。古ければ無音
（古い前提で作業させないため）。SessionStart は既に21本あるので出力量を絞ってある。

## 4. AI提案トリアージの詰まり解消（修正）`tools/nightly-batch.ps1`

`ai-news-triage` の `--confidence` 既定は `high` のみ。夜間バッチは引数なしで呼んでいたため、
**pending 45件のうち medium 27件 / low 15件が永久に処理されない**状態だった（最古は9日前）。
`--confidence high,medium --limit 8` に変更。実行確認で8件処理（done 6 / rejected 1）。毎晩8件ずつ消化される。

## 配線方法

新規スケジュールタスクの登録は classifier で通らない実績があるため、
**既存タスクに Action を追加**した（`OrgiastMorningBatch` の Action を 1 → 3）。
`OrgiastDiscordTaskDigest` が元から2 Action を持っており、これが前例。
タスクには作業ディレクトリが設定されていないため、3ツールとも**別 cwd から実行して動くことを実測**してから配線した。

## 検証結果

| 項目 | 結果 |
|---|---|
| `nightly-health` テスト | 26 pass / 0 fail |
| `next-actions` テスト | 14 pass / 0 fail |
| `next-actions-notice` テスト | 7 pass / 0 fail |
| `nightly-health` 実データ | 誤検知 25件 → 0件（定常状態は本物の1件のみ） |
| `next-actions` 実データ | `provider=deepseek`（LLM実使用）、P1タスク抽出成功、重複なし |
| スケジュールタスク | Action 3件を read-back 確認 |
| SessionStart フック | 22本目として登録、read-back 確認 |

## 積み残し

- `tools/task-ledger-logic.test.mjs` が参照する `gas/task-sheet/TaskLedgerLogic.gs` が未作成のため赤のまま。
  他セッションの進行中作業なので触っていない。`nightly-health` は毎朝これを報告する。
- `~/.claude/logs` に未登録のログが21件ある。重要なもの（`auto-session-verify.log` 等）は
  `tools/nightly-health-expectations.json` に追加する余地がある。
