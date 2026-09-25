# 「恒久修正を設計のみで次セッションへ送る」handoff の監査（2026-09-23 実測）

対象 TODO: `[handoff-audit:2329d24dba4d6e0b]`（route 欄は `codex-do.mjs`）

結論:

1. **再発している（実物で確認）。** 同日 2026-09-22 の stop-gate 台帳に本 pattern の逐語例がある（「恒久修正 … は next-session.md 残TODO 2番で対応」）。先送り語を含む違反は **09-22 が 6 件で最多**（09-15〜09-22 で増加傾向）。
2. **ただし監査側の再発検知は効いていない。** 本 pattern の lesson は nightly（03:00 JST）が confidence=high で昇格した **19 分後に sync で上書きされて消えた**。origin/main にも実行時のどのコピーにも存在しない（§3 実測）。observation は処理済みとして記録済みのため二度と再生成されない。
3. route 欄の `codex-do.mjs` は手順ではなく `automation-routes.json` の「委譲」値の逐語引用。しかも**本 PC では WSL 不在で codex 経路が起動しない**（9/9 が fastFail）。
4. 恒久化として本 pattern を `tools/handoff-audit-knowledge.json` に**手順文 route** で追加し、route が道具名へ戻ったら落ちるテストを `tools/handoff-audit-gate.test.mjs` に追加した（§6）。

---

## 1. この pattern の出所（実測）

`~/.claude/handoff-audit-nightly-ledger.jsonl` 2026-09-22T18:00:47.309Z / session `1ba89ba5-ba63-4a5d-8ed3-97b782cebbb7` / verdict=**block**:

| rule | quote | fix（監査の指示） |
|---|---|---|
| 2 | 「このタブは閉じる対象なので、ここでは実装せず次セッションが自走します」 | 「次セッションが自走」は先送り。codex-do.mjs で当ターン内に実装可能。やらない理由が品質に基づかない |
| 3 | 「恒久修正の中身（設計済み、実装は未着手）…正本リポへ fork→PR で出し、kim のマージ後に全PCへ配布」 | 実装は Claude 側で完結可能。next-session.md に積むだけでなく実装し gh CLI で PR を出せば kim の作業はマージ1回のみ。配布待ちを理由に未着手を正当化しない |
| 10 | 「次に kim がすること: この「/session-start」タブを ✕ で閉じる」 | 末尾行の形式は維持しつつ、タブを閉じる行為を user に要求しない設計に |

`learned`: `{pattern:"恒久修正を設計のみで次セッションへ送る", route:"codex-do.mjs", confidence:"high"}`。
同じ session は同日に「セッション jsonl の退避を user に『タブを閉じる』で依頼」（route:`チャット表示`, medium）も出しており、**同一の handoff から独立した2つの pattern が生成されている**。

## 2. 再発の実測（成果物側）

- `~/.claude/stop-gate-runner-ledger.jsonl` 258 行のうち「次セッション／設計済み／未着手／実装せず／先送り／次ターン」を含む違反は **14 行**。
  日別: 09-15:1 / 09-16:2 / 09-17:1 / 09-18:1 / 09-20:1 / 09-21:2 / **09-22:6**。
- 逐語例（2026-09-22T15:14:24Z / session `832c5064`）:
  > この後の自動進行: タブを閉じれば次セッション開始時の purge が本IDを自動退避し一覧から消える。**恒久修正（purgeが再出現IDを再退避する改修）は next-session.md 残TODO 2番で対応。**
  ＝ 設計済みの恒久修正を実装せず次セッションへ送った実例（本 pattern そのもの）。
- `~/.claude/handoff-audit-ledger.jsonl`（手渡しゲート側・171 行）に本語を含む違反は **0 行**。＝ 手渡しゲートは本 pattern を捕まえず、block しているのは stop-gate 側だけ。
- `~/.claude/auto-session/runs/*.summary.md` 26 件に「設計のみ・次セッションで実装」型の記述は **0 件**（唯一の「未着手」は範囲外テストの記載）。＝ 自動セッションでは観測されず、**対話セッション + next-session.md 側で発生**している。

## 3. lesson が消えている（実測）

`handoff-audit-knowledge.json` の全コピー:

| 対象 | 件数 | 本 pattern | mtime (UTC) |
|---|---|---|---|
| `~/orgiast-claude-rules/tools/`（実行時ツリー） | 17 | 0 | 2026-09-22T18:20:08Z |
| `~/.claude/nightly-repo/tools/`（git クローン） | 17 | 0 | 2026-09-21T18:28:03Z |
| `~/.claude/repo-backups/tools.bak-2026-09-22/` | 13 | 0 | 2026-09-21T05:12:49Z |
| `~/.claude/repo-backups/tools.bak-2026-09-21/` | 8 | 0 | 2026-09-19T18:20:13Z |
| `~/.claude/repo-backups/tools.bak-2026-09-19/` | 8 | 0 | 2026-09-16T18:22:29Z |

- nightly の書き込み先は `$PSScriptRoot` 基準（`tools/nightly-batch.ps1:86` が `Join-Path $PSScriptRoot 'handoff-audit-nightly.mjs'` を実行、knowledge は `import.meta.url` 相対）。
  タスク `OrgiastNightlyBatch` の実行パスは `C:\Users\user\orgiast-claude-rules\tools\nightly-batch.ps1`（`Get-ScheduledTask` 実測）＝ **書き込み先は git 管理外の実行時ツリー**。
- 実行時ツリーの knowledge mtime は **2026-09-22T18:20:08Z ＝ nightly（18:00:47Z）の 19 分後**。
  `~/.claude/onboarding-sync-fallback.json`（mtime 18:20:19Z・652 files）が同 path に記録した hash `bd842df44720d0dd405e69393370f6a355c540d363662034ab6457ede75da75a` は、
  **実行時ファイルおよび origin/main の両方と一致**（＝ main 版 17 件に戻された）。
- 影響: nightly が昇格した lesson は **PR で main に入るまで存在できない**（次の sync で必ず消える）。
  さらに observation は nightly-ledger に block 行として残るため `done` に入り（`handoff-audit-nightly.mjs:90`）、**二度と再監査されない**。
  本 pattern の痕跡は `~/.claude/next-session.md` の TODO 1 行と、この doc だけになる。

## 4. route 欄の妥当性（実測）

- `tools/handoff-audit-gate.mjs:61` は learned.route を「下記 knowledge の route **又は automation-routes の値をそのまま引用**する」と指示している。
  `tools/automation-routes.json` の `委譲 => "codex-do.mjs"` が逐語で入ったもので、**再発防止の手順ではない**。
- `tools/codex-do.mjs`（origin/main・850 行）は**前景・単発**。フラグは `--prompt-file` / `--cwd` / `--lane` / `--timeout` / `--dry-run` / `--no-fallback` / `--allow-native` 等で、背景実行・進捗待機の機能は無い。
- 本 PC 実測: `wsl -l -q` は**空**（WSL ディストリ無し）。`~/.claude/executor-usage.jsonl` の 2026-09-22 の codex 実行 **9 件は 9/9 が `status:3` / `fastFail:true` / stderr「WSL ディストリが見つかりませんでした」**。
  native 経路は read-only 固定の既知不具合があり既定では使わない。＝ 「codex-do.mjs で当ターン内に実装」は**本 PC ではそのままでは実行できない**（内蔵フォールバックが受ける）。
  → 正しい手順は「前景・単発で回し、起動不能なら Gemini/DeepSeek → それも不可なら Claude 直で実装し、gh CLI で PR まで進める」。

## 5. 成果物側の残存（origin/main 実物）

`~/.claude/next-session.md` は 14 TODO（13 件が 2026-09-22 更新）。設計済み・実装先送り型は 4 件で、origin/main の実物でも未実装を確認:

- `[codex-do のフォールバック試行ごとの台帳記録]` — **未実装**。`codex-do.mjs` のフォールバックループ（L776〜）は `timedOut`(L800) / `isBackendExhausted`(L808) で `continue` するだけで `recordUsage` を呼ばず、最後に L844 の 1 回のみ。
- `1a. [close-session 恒久修正・小]` — **未実装**。`tools/close-session.mjs`（82 行）の完了文は英語 1 行のまま。`tools/purge-hidden-sessions.py`（388 行）に `closed-sessions-archived` の参照は 0 件（履歴保持が未実装）。
- `PROMOTE 待ち feedback-request-text-inline` — `internal-recipient-gmail-guard.mjs` は実在するが、「チャットに全文を出したか」を検査する Stop ゲートは `text-inline` 系ファイル 0 件で**未実装**。

## 6. 本セッションで実施した恒久化

- `tools/handoff-audit-knowledge.json` に pattern「恒久修正を設計のみで次セッションへ送る」を **手順文 route** で追加
  （sync で消えないよう main に入れる。source は nightly の observation を保持）。
- `tools/handoff-audit-gate.test.mjs` に「route が手順文であり道具名へ戻っていない」検査を追加。

## 7. 推奨（class 側・本セッションでは未実施）

nightly の knowledge 書き込み先が git 管理外の実行時ツリーである限り、昇格した lesson は次の sync で消える。案:

- (A) nightly が knowledge を書いたら fork→PR まで自動で出す（差分は小さいが、夜間に push 権限を持つ）
- (B) knowledge を `~/.claude/handoff-audit-knowledge.json`（sync 対象外）へ移し、module 側は seed として読む
- (C) sync 側で knowledge を 3-way マージし、ローカル追加分を保持する

推奨は (B) → (C)。(A) は blast radius が最も大きい。
判定材料: 実行時ツリー knowledge mtime 18:20:08Z > nightly 18:00:47Z / sync 記録 hash が main 版と一致 / observation の再処理不可（`handoff-audit-nightly.mjs:90`）。

## 8. 未確認（断定も確率表現もしない）

- 「18 件 → 17 件に書き換わった瞬間」の一次記録は無い。§3 は mtime と sync の hash 記録からの推定であり、
  **nightly の書き込みが成功していたことを直接見たわけではない**（書き込み先が実行時ツリーであることは `$PSScriptRoot` とタスク定義から確認済み）。
- 監査台帳の「学習後」の窓は **0 行**（gate ledger 最終 15:24:31Z < 学習 18:00:47Z）＝ **本 pattern の今後の再発は未確認**。
- 対話セッションの summary は存在しないため、§2 の 14 行すべてが本 pattern とは限らない（逐語で本 pattern と確認できたのは `832c5064` の 1 例）。
