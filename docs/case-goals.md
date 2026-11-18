# 案件の目標と必要ペース

`case-goals.mjs set <caseId> --metric <名> --target <数> --deadline YYYY-MM-DD --source "kim指示の引用と日時"` で目標を登録する。数値が未確定なら勝手に設定しない。更新は同じmetricに対して行い、小さいtargetには毎回 `--kim-approved "kimの承認文の引用"` が必要（無い場合exit 2）。承認・元指示・以前の目標は履歴に残す。

`progress <caseId> --metric <名> --current <数> --sent <送信済み数>` で実績を記録し、`show <caseId>` / `list` で確認する。保存先は `~/.claude/case-sessions/<caseId>/GOALS.json`。必要ペースは残数÷JST暦日の残日数（当日は1日として計算）、小数第2位切上げ。送信済み数と成約数は別の指標であり、同一視しない。

Stop は `case-binding/<session_id>.json` の全案件・全metricを照合する。期日当日を含む目標には `【目標進捗】課題提供企業: 目標 10 / 現状 1 / 期日 2026-12-12 / 必要ペース 0.38/日` の形の行が必要。未達で残り7日以内なら同じ段落に `遅れ。明日10社へ送信する` や `遅れ。別経路: 電話で追加打診する` を書く。台帳の数値と異なる行・他の節の打ち手・コードブロックの例示では通らない。台帳破損はGOAL-PACEとして停止する。

送信前の `send-context-check.mjs` は `--case <caseId>`、`--session <sessionId>`（またはCLAUDE_SESSION_ID）、本文に明記した案件IDから目標を集める。案件IDのない社外本文では必ず `--case` または `--session` を付ける。現在確定している数の報告と目標枠の縮小を区別し、明白な縮小は機械判定、言い換え・合算は既存のGemini→Groq→DeepSeek照合で検査する。送信承認・意図した変更のオプションでGOAL-SHRINKを解除できない。Claude APIは使用しない。

## Driveへの引継ぎ

`case-handoff.mjs` の同期対象は STATE.md / LOG.md / GOALS.json。目標台帳は既存のGWSプロキシ（制作アカウント）で、同じDriveハブの `case-sessions/<caseId>/` に保存する。目標CLIは更新前後、case-handoffは再開・同期・案件検出・明示bindの際に目標を同期する。フォルダ作成は既存case-handoff APIに任せ、独立して同名フォルダを作らない。同期失敗は無言にせず再試行コマンドを示す。GOALS-sync.jsonに失敗状態を残し、初回取得失敗を「目標なし」と誤認してStop・送信チェックを通さない。

Drive v3プロキシには条件付き更新がないため、`GOALS.<revision>.json` を変更不可の履歴として保存し、`GOALS.json` は最新履歴の投影にする。全revisionを読み、祖先の包含・承認履歴の連続性を検証してからローカルに反映する。複数席の同時更新が分岐した場合はGOAL-SYNCとして停止し、両方の履歴を保持する。削除・時刻だけでの上書き・無承認の自動縮小はしない。競合時は両方の目標と承認文を照合して台帳を修復してから再同期する。ローカルだけを消してやり直さない。

配布は `setup --converge` → register-hooks → hook-dispatch の共通経路。Stop実体は `hooks/goal-pace-gate.mjs`、既存レジストリ互換の入口は `tools/goal-pace-gate.mjs`。全PC・全アカウントで即時deny、hook-selfcheckも欠落を修復する。ルールはONBOARDINGの🔴行からCLAUDE.mdへ同期する。
