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

## 9. 2026-09-26 再検証（`[handoff-audit:118179e5fdc98641]`）— §7 は前回監査自身が先送りしていた

### 9.1 本 pattern の再発（実測・前回監査 2026-09-23 以降）

`tools/permanent-fix-deferral-scan.mjs --since 2026-09-23T00:00:00Z` の実測:

| 台帳 | hits / 総行 | 内訳 | 判定 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | **2** / 1890 | 09-23:1, 09-24:1 | いずれも「Codex の実装完了を待っている」＝§1.18 の正規委譲待ち。両方とも `次に kim がすること: なし` で、**待たせている相手は user ではない** |
| `handoff-audit-ledger.jsonl` | **0** / 894 | — | 手渡しゲートは本 pattern を一度も捕まえていない（前回と同じ） |
| `handoff-audit-nightly-ledger.jsonl` | **1** / 325 | 09-25:1 | `次に kim がすること: なし（Codex の完了待ちです）` ＝同上 |

→ **有害形（恒久修正を実装せず次セッションの TODO 番号へ送る）の再発は 0 件。** 前回監査が逐語で捕まえた `832c5064`（09-22）以降、同型は観測されていない。

### 9.2 §6 の恒久化は生き残っている（実測）

`tools/handoff-audit-knowledge.json` の `恒久修正` は main の HEAD 版に存在し、実行時ツリー（`~/orgiast-claude-rules/tools/`）にも入っている（前回監査の懸念「sync で消える」は**この entry に関しては起きなかった**）。

### 9.3 本題: 前回監査は §7 を「設計のみ」で先送りした ＝ 本 pattern の自己適用

前回監査 §7 は「nightly の knowledge 書き込み先が git 管理外の実行時ツリーである限り昇格した lesson は消える」と正しく診断しながら、見出し自体が **「推奨（class 側・本セッションでは未実施）」** であり、3日後の本日まで**未実装**だった。監査対象の pattern を監査した当のセッションが、その pattern を実行している。

**真因の精密化（前回診断の是正）**: 前回は「毎時 sync が上書きする」と推定した（§3）。今回の実測では、消去は sync を待たずに**毎晩の起動時に確定で起きる**:

- `Get-ScheduledTask OrgiastNightlyBatch` → `~/.claude/tools/nightly-bootstrap.ps1 -Target tools\nightly-batch.ps1`
- bootstrap は `$repo = ~/.claude/nightly-repo` に対し **`git reset --hard origin/main` ＋ `git clean -qfd`** を実行してから target を走らせる（`nightly-bootstrap.ps1:162-173`, `:258`）。
- `handoff-audit-nightly.mjs:84` の knowledge は `import.meta.url` 相対＝**その reset 対象ツリーの中**。`:102` の書き込みは翌晩の起動時に必ず捨てられる。
- ※前回 §3 が記録した実行パスは `C:\Users\user\orgiast-claude-rules\tools\nightly-batch.ps1`（別ユーザー名）だった。現在のタスク定義は上記のとおりで、**書き込み先が変わっている**。前回の記述は現状に一致しない。

**被害の範囲（過大評価しない）**: route 文は消えるが、pattern 名は `enqueueTodos`（`handoff-audit-nightly.mjs:106`）で `~/.claude/next-session.md` の handoff-audit TODO 行に残る（このファイルは git 管理外で reset 対象でもない）。したがって**全損ではなく、毎晩 route 文だけが失われ、次セッションが再導出する**コストが払われ続けている。

### 9.4 本セッションで実装した恒久修正（§7 の実施）

- `tools/handoff-audit-nightly.mjs`: 昇格した lesson を `~/.claude/handoff-audit-promotions.jsonl`（**どの git ツリーにも属さない append-only 台帳**）へ追記。`promotionFile(home)` を export。戻り値に `promoted` 件数を追加。＝ reset で route 文が消えなくなる。
- `tools/permanent-fix-deferral-scan.mjs`（＋ test）: 本 pattern の再発を3台帳から再実行可能に測るレポータ。次回以降の監査は手書きスキャンを要さない。
- テスト: `node --test tools/handoff-audit-nightly.test.mjs tools/permanent-fix-deferral-scan.test.mjs` = **11/11 pass**。

### 9.5 未確認（断定も確率表現もしない）

- `~/.claude/handoff-audit-promotions.jsonl` は本セッションで新設したため**実データは 0 行**。次回以降の nightly で初めて書かれる。実書き込みは未確認。
- §7 の (A)（nightly が fork→PR を自動で出す）は**未実装のまま**。今回の修正は「消えなくする」までで、「main へ自動で届く」ところまでは行っていない。
- stop-gate 台帳の最終行は 2026-09-25T17:55Z。**2026-09-26 の対話セッションは 0 行**のため、直近1日の再発は未確認。

## 10. 2026-10-04 再検証（`[handoff-audit:fa94cbb0569e2066]` / `[handoff-audit:cfa639f9ba586821]`）

対象（本 TODO が名指しする2件。いずれも原価フロア実装の先送り）:

| 検出 | ts | session | pattern | 逐語 |
|---|---|---|---|---|
| `fa94cbb0` | 2026-10-01T18:08:25.122Z | `299ef38c` | P1 | 「この後の自動進行: next-session.md item 2（原価フロア実装）を**次セッションで** Codex へ委譲して実施」 |
| `cfa639f9` | 2026-10-01T15:34:19.422Z | `2811a555` | P2 | 「この後の自動進行: **次セッションが** next-session.md の新TODO「原価フロアを実装し…」を拾って着手する」 |

### 10.1 結論

1. **先送りされた恒久修正は着地済み。** 原価フロアは tetsuko-unified PR #18（`df54f37`）で origin/main に入った（§10.2 実物確認）。先送り宣言から約22時間で実装まで到達しており、有害形（実装せず TODO 番号へ送るだけ）には至っていない。
2. **この pattern の再発は 2026-10-01 の2件を最後に 0 件**（10-03 JST 窓まで実測・§10.3/10.4）。
3. 前回 10-01 窓に出た P3×2 は引用連結の越境誤検出で、#619 で解消済み（§10.6）。

### 10.2 先送りされた修正は着地している（実測）

- `gh pr view 18 -R .../tetsuko-unified`: **MERGED 2026-10-02T16:07:49Z**（＝2026-10-03 01:07 JST）。
- `git merge-base --is-ancestor df54f37 origin/main` → **true**。`git ls-tree origin/main` に `db/migrations/20261003_cost_floor.sql` と `tools/verify-cost-floor.mjs` が実在。
- ＝ 10-02 03:08 JST の先送り宣言から **約22時間**で着地。本 PC では「Codex へ委譲（§1.18）」自体は正規の実装経路であり、有害なのは「実装せず次セッションの TODO 番号へ送るだけ」の形。今回は後者になっていない。

### 10.3 再発の実測（検出器・3台帳の全履歴）

`node tools/permanent-fix-deferral-scan.mjs`（`--since` 無し＝1970 から全件）:

| 台帳 | hits / 総行 | 日別 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | **5** / 335 | 09-20:1, 09-24:1, 09-25:1, **10-01:2** |
| `handoff-audit-ledger.jsonl` | **0** / 225 | — |
| `handoff-audit-nightly-ledger.jsonl` | **1** / 57 | 09-24:1 |

→ **最後の検出は 2026-10-01（本 TODO の2件）。それ以降の検出は 0 件**。手渡しゲート（handoff-audit-ledger）は §9 と同じく本 pattern を一件も捕まえていない。

### 10.4 未記録だった 10-03 JST 窓を先に実測（「測った 0」）

nightly による 10-03 窓の記録は今夜 03:00 の実行待ちのため、その窓を手で先に測定した:

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-02T15:00:00Z --until 2026-10-03T15:00:00Z`
→ 3台帳すべて **hits=0**。窓内の実データ行は stop-gate **10行** / audit-ledger **5行**（nightly 0行）。
**空の 0 ではなく、行のある窓を測った 0。**

### 10.5 検出器は稼働している（「0 は測った 0」の裏取り）

- `Get-ScheduledTaskInfo OrgiastNightlyBatch`: 最終実行 **2026-10-03 03:01:01 / LastTaskResult 0**。次回 2026-10-04 03:00。
- `~/.claude/handoff-audit-deferral-ledger.jsonl` の window 行（窓＝前日0時〜当日0時 JST）:

| 窓（JST） | hits | 内訳 |
|---|---|---|
| 09-29 | 0 | — |
| 09-30 | 0 | — |
| 10-01 | 2 | P3×2（§10.6 の誤検出） |
| 10-02 | 2 | P1×1, P2×1（＝本 TODO の2件） |
| 10-03 | （未記録） | 本 doc §10.4 で先に実測=0 |

### 10.6 検出器側の既知誤検出は解消済み

10-01 窓の P3×2（session `964d909c`）は `violations[].quote` を `' ~ '` 連結して detect していたことによる越境検出。**#619（2026-10-02T15:37:18Z merge）**で quote 単位の detect に修正済み。

### 10.7 未確認（断定も確率表現もしない）

- 10-03 JST 窓の **nightly による**記録はまだ無い（今夜 03:00）。§10.4 は同窓を手で先に測ったもの。10-04 JST 窓以降は未測定。
- 原価フロアの**本番DB実測**（原価割れ 0 行）は 2026-10-03 のセッションが確認済み（memory `project-tetsuko-cost-floor-applied-verified`）。本 doc ではコード側（origin/main の実在）のみ再確認し、DB は再測定していない。

## 11. 2026-10-05 再検証（`[handoff-audit:9058ecf9c24d8dca]`）

対象（本 TODO が名指しする1件。2026-10-03T18:00:41.151Z / session `bbd0a4a2-bd70-4d26-bf22-947ef3fb5981` / pattern P3）:

> に、Discord の DM か管理画面から対応を進めていただくのがよいと思います。 ~ 次に kim がすること: アシスタントに未対応 5 件の対応を依頼する ~ 引き続き目視で確認してください ~ 実装担当（DeepSeek）が一時的な利用制限に入っていたため、別の担当に切り替えて走らせています。

### 11.1 結論

1. **この「検出」は誤検出であり、再発ではない。** 記録された P3 は #619 以前の**引用連結**（`violations[].quote` を `' ~ '` で繋いで detect）による越境一致で、元 entry を**現行検出器で quote 単位に当てると 0 件**（§11.2・§10.6 と同型）。
2. **本 pattern の再発は 2026-10-02 を最後に 0 件。** 全履歴スキャンで、現行検出器が拾う P3 の最終ヒットは `2026-10-02T18:00:12`（これも §10.6 の誤検出）。10-03T18:00 の P3 は現行検出器では再現しない（§11.3）。
3. **検出器は稼働し、配備コピーは現在 #619 修正済み。** 誤検出を出した 10-04 18:00Z の run の**34秒後**に配備コピーの検出器が更新されており、今は origin/main と byte 一致（§11.5）。以後の窓で同じ誤検出は出ない。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみで実施。

### 11.2 元 entry は現行検出器で 0 件（誤検出の確定）

`~/.claude/handoff-audit-nightly-ledger.jsonl` の `2026-10-03T18:00:41.151Z` entry（session `bbd0a4a2` / verdict=block / violations 5件）の各 quote を現行 `detect()` に直接当てた実測:

| # | rule | quote（先頭） | detect |
|---|---|---|---|
| 0 | 2 | アシスタントの方に、Discord の DM か管理画面から対応を… | **0件** |
| 1 | 3 | 次に kim がすること: アシスタントに未対応 5 件の対応を依頼する | **0件** |
| 2 | 5 | 引き続き目視で確認してください | **0件** |
| 3 | 4 | 実装担当（DeepSeek）が一時的な利用制限に… | **0件** |
| 4 | 2 | Discord の DM か管理画面から対応を進めていただく | **0件** |

- quote #1 は `次に kim がすること:` の行だが、続く語が「アシスタントに**未対応** 5 件の**対応**を依頼する」で、`FIX=/実装|修正|改修|恒久|…/` に当たらない（P3 は恒久修正語が要る）。
- 記録された hit 行の `match` が `' ~ '` 連結文なのは、この連結が行われていた版の出力。連結すると別 quote の「実装担当（DeepSeek）…」が FIX 語として拾われて誤一致する。
- 陽性/陰性対照: 連結文を `detect()` に与えると P3 で一致（陽性）、正常な handoff 文では 0 件（陰性）。＝ **検出器は生きている。0 は測った 0。**

### 11.3 全履歴スキャン（現行検出器・`--since` 無し）

| 台帳 | hits / 総行 | 日別 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | **8** / 617 | 09-19:1, 09-21:1, 09-22:2, 09-24:1, 09-25:1, 10-02:1, **10-03:1** |
| `handoff-audit-ledger.jsonl` | **0** / 417 | — |
| `handoff-audit-nightly-ledger.jsonl` | **1** / 155 | 09-22:1 |

- stop-gate の 10-03 の1件は `2026-10-03T14:33:41`（session `767bdbbb` / pattern **W**）＝「エージェントの完了を待って結果を統合します」。対象 P3 ではない。
- **P3 の最終ヒットは `2026-10-02T18:00:12`**（session `bbd0a4a2`、§10.6 の連結誤検出）。対象の 10-03T18:00 は現行検出器の一覧に現れない。

### 11.4 窓の実測（記録値との差＝誤検出の証明）

| 窓（UTC） | 記録（deferral-ledger） | 現行検出器の再実行 |
|---|---|---|
| 10-03T15:00 〜 10-04T15:00 | **hits=1**（＝対象の P3） | **3台帳すべて 0** |
| 10-04T15:00 〜 現在 | （未記録） | **3台帳すべて 0** |

＝ 記録窓を同じ入力で再実行すると 0。**記録された 1 件は現行検出器の入力では発生しない**。
夜間の window 行（直前7件）: 09-29:0 / 09-30:0 / 10-01:0 / 10-02:1 / 10-03:2 / 10-04:1。うち 10-02・10-03・10-04 の hit は §10.6 と本節の連結誤検出。

### 11.5 検出器の稼働と版（「0 は測った 0」の裏取り）

- `Get-ScheduledTask OrgiastNightlyBatch`: 実行 `...\orgiast-claude-rules\tools\nightly-batch.ps1`（＝**配備コピー**）。
  `Get-ScheduledTaskInfo`: 最終 **2026-10-05 03:00:00 / LastTaskResult 0**、次回 10-06 03:00。
- 配備コピー `...\orgiast-claude-rules\tools\permanent-fix-deferral-scan.mjs` の mtime は **2026/10/05 3:01:13 JST**
  （= 2026-10-04T18:01:13Z）。誤検出を出した窓 run の ts は `2026-10-04T18:00:39Z` ＝ **その34秒後**。
- 同ファイルは現在 `~/.claude/nightly-repo/tools/` 版と **byte 一致**（diff 一致）。`~/.claude/nightly-repo` 版の最終更新は #619
  （`465b958` / 2026-10-03T00:54:24+09:00）。＝ **配備コピーは 10-04 18:01Z 以降 #619 修正版で走っている。**

### 11.6 対象 handoff の実体（誤検出タグの外側にある本物の違反）

session `bbd0a4a2` は nightly 監査で **verdict=block**（violations 5件: rule 2/3/5/4/2）。逐語は
「アシスタントの方に、Discord の DM か管理画面から対応を進めていただく」「次に kim がすること: アシスタントに未対応 5 件の対応を依頼する」
「引き続き目視で確認してください」。これは**恒久修正の先送り（本 pattern）ではなく**、顧客対応の人手 handoff（rule 2/3/5）である。
本 TODO が名指す「恒久修正の先送り」としての再発は無い（§11.3）。

### 11.7 未確認（断定も確率表現もしない）

- 10-04 18:00Z の run が pre-#619 版で走った**一次記録**は無い。§11.5 は配備コピーの mtime と現行 diff 一致からの推定であり、
  当該 run が旧版を import していたことを直接ログで見たわけではない（誤検出の `match` が連結形である事実とは整合）。
- 10-04T15:00 以降の窓について、**nightly による**記録はまだ無い（次回 10-06 03:00 JST）。§11.4 は同窓を手で先に測ったもの。
- §11.3 の P3 以外のヒット（P1/P2/P4/W）の有害・無害の仕分けは本節では行っていない（W の 1 件は §9 と同じ「委譲待ち」型と読めるが逐語精査はしていない）。

## 11. 2026-10-06 再検証（`[handoff-audit:4cf55b5935cd7f61]`）— 10-03 の P1 は検出器自身の名称の自己言及（誤検出）

対象: `2026-10-03T15:39:54.760Z` / session `25d638db` / pattern **P1** / verdict block。

### 11.1 結論

1. **この検出は誤検出。** `25d638db` は handoff-audit の再発を検証した側のセッションで、その出力本文が
   検出器自身の名称「恒久修正の先送り文」と、検証対象の説明「原価フロア実装の先送り」を含んでいたため、
   P1 の regex が**自己言及**に当たった（P3 の越境誤検出 §10.6 と同類）。
2. **当ターンで実装すべき先送りは無い。** `25d638db` は実作業を完了済み（PR #629 MERGED
   `2026-10-03T15:38:43Z`、本 doc §10 追記）。検出 ts はその 71 秒後。
3. **先送りされていた恒久修正（原価フロア）は着地済み**（§10.2: tetsuko-unified #18 `df54f37`）。

### 11.2 逐語（実測）

`node tools/permanent-fix-deferral-scan.mjs` 全履歴の stop-gate-runner-ledger 当該行の一致を `detect()` で確認:

- 一致1: `恒久修正の先送り`（index 36）＝「**「恒久修正の先送り文」が再発していないかを実物で検証し**」
- 一致2: `実装の先送り`＝「…`2811a555`/P2＝**原価フロア実装の先送り**）を実物検証し、記録を」— 実測 `実装の先送り`（14文字）。

いずれも先送りを**実行**した文ではなく、先送りを**名詞句で説明**した文。

### 11.3 全履歴の再発（実測）

| 版 | stop-gate-runner-ledger | 日別 |
|---|---|---|
| 修正前 | **6** / 349 | 09-20:1 09-24:1 09-25:1 10-01:2 **10-03:1** |
| 修正後 | **5** / 349 | 09-20:1 09-24:1 09-25:1 10-01:2（**10-03 消滅**） |

handoff-audit-ledger 0/232 / nightly-ledger 1/57 はいずれも不変。**真の検出5件は全て維持**。
観測済みの真の検出は全て `次セッション`/`次回セッション` 経由で、`先送り` 単独一致は本誤検出のみだった。

### 11.4 恒久修正（本セッションで実施）

P1 regex の `先送り` を `(?<!の)先送り(?!文)` に変更。**名詞句形**（「〜の先送り」「先送り文」）を除外し、
**行為形**（先送りする/した/にする）は前後が「の」でも「文」でもないため残す。テスト2本追加して
`node --test tools/permanent-fix-deferral-scan.test.mjs` = 13/13 pass。

### 11.5 未確認（断定も確率表現もしない）

- 名詞句除外の副作用として、真の先送りを「修正の先送りを決めた」のように `〜の先送り` と書いた場合は
  取り逃がしうる。観測済みの実例は無い。
- self言及の他の語形（例: 検出器名を別の言い回しで引用）が将来 P1/P2 を自己トリガする可能性は未検証。
