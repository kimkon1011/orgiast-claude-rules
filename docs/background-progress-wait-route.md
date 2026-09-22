# 「バックグラウンド再生成の進捗待ち」handoff の監査（2026-09-22 実測）

対象 TODO: `[handoff-audit:64119511293ffa00]` バックグラウンド再生成の進捗待ち（経路として `codex-do.mjs` が記録されていた）
結論: **`codex-do.mjs` はこの手渡しの経路ではない。**「進捗待ち」は Claude が背景ジョブの状態を**証拠つきで直接照会**し、待ちは**次セッション再入**に載せる。

---

## 1. この pattern の出所（実測）

`~/.claude/handoff-audit-nightly-ledger.jsonl` の該当行:

| ts | sessionId | verdict | learned |
|---|---|---|---|
| 2026-09-18T18:09:30Z | 6701b712-b0cd-49ca-8f0a-ae2e5e7ba02b | pass | `{pattern:"バックグラウンド再生成の進捗待ち", route:"codex-do.mjs", confidence:"high"}` |

同じ session の元の発言（`~/.claude/handoff-audit-ledger.jsonl` 2026-09-18T09:48:01Z, verdict=**block**）:

> 「エージェントは写真差し替え後の再生成をバックグラウンドで実行中（中間通知）」
> fix: Claude側で対象ベンダーのAPIを直接照会し、結果が無ければ『未確認』と記す。外部状態の断定は証拠なしで行わない。

つまり pattern の実体は「**証拠なしに背景ジョブの状態を断定して待たせた**」ことで、rule 4（外部状態は直接照会だけが証拠）の違反。
`route:"codex-do.mjs"` は `tools/automation-routes.json` の `CLI` グループから**そのまま引用された道具名**で、再発防止の手順ではない
（監査プロンプトは `routeは下記knowledgeのroute又はautomation-routesの値をそのまま引用する` と指示している。`handoff-audit-gate.mjs:61`）。

## 2. codex-do.mjs の実測（この handoff を担えるか）

`tools/codex-do.mjs` の usage と実装から確認（832 行）:

- 実行形態は**前景・単発**。`--dry-run` / `--no-fallback` / `--lane` / `--timeout <秒>`（既定 1800）を持つが、**背景起動・進捗照会・待機の機能は無い**。
- 完了/進捗の証拠は `~/.claude/executor-usage.jsonl` に1実行1行で残る（`recordUsage`, 行 571-588）:
  `t` / `provider` / `model` / `lane` / `in` / `out` / `launched` / `timedOut` / `status` / `cwd` / `stderrTail` / `fastFail` / `attempts` / `secs`（実測 7,487 行）。
- したがって「進捗待ち」を codex-do.mjs で表現することはできない。**できるのは「前景で timeout を切って回し切る」か「回した事実を台帳で確認する」だけ。**

ヘッドレス auto-session（`claude -p` 1回）ではさらに制約が重なる:
Bash ツールの 600 秒上限で自動的に背景化し、**ターン終了時にプロセスごと kill** される（memory `feedback_codex_delegation_needs_deps_preinstalled` 2026-09-21 実測）。
`run_in_background` と `ScheduleWakeup` はセッション規約で禁止。

## 3. 正しい経路（推奨）

1. **待たない。** 長時間ジョブは前景で `--timeout` を切って回し切るか、実行基盤（GitHub Actions / タスクスケジューラ / auto-session 再入）に載せる。
2. **進捗は直接照会する。** 委譲の完了は `~/.claude/executor-usage.jsonl`（`status`/`out`/`timedOut`/`secs`/`cwd`）、
   外部ジョブは `gh run view` 等の一次情報。照会できないなら**「未確認」と書き、断定も確率表現もしない**（監査基準 rule 4）。
3. **待ちは次セッションに載せる。** `~/.claude/next-session.md` の残TODO先頭に**検証だけの1行**を足して終了する。
   セッションを開いたまま「バックグラウンド実行中」と報告しない。

## 4. 残存状況（実測）

- 進捗待ち/バックグラウンド系の監査行: `handoff-audit-ledger.jsonl` で **66 行 / 23 セッション**、うち verdict=block **26 件**。
  日別では 2026-09-17 (22)・09-18 (30) がピーク、**09-19 以降は 1日 2 件**まで低下＝外部状態ゲートで概ね抑止済み。
- ただし `docs`/`knowledge` に**この pattern の経路が無かった**ため、監査 TODO が空回りしていた（本セッション）。

## 5. 併せて観測した route 欄の欠陥（別件・修正は未実施）

`next-session.md` の open な handoff-audit TODO **82 件のうち 43 件（52%）の route が `codex-do.mjs`**。
内訳は「進捗待ち」だけでなく **`settings.json の許可ルール追加・検証`（9件）・`classifier 拒否`・`セッション自動起動失敗`・`Discord ロール操作`** など、
codex-do.mjs と無関係な pattern が並ぶ。**route 欄が再発防止手順ではなく道具名**になっているため、検証対象が pattern ではなく道具になり、同じ道具が繰り返し監査される。

実測（`runs/2026-09-22-9-probe.mjs`）:

- route 重複排除（#496, 2026-09-20）は**現行コードでは有効**。旧形式・新形式どちらの TODO 行があっても、同 route の新規 item は追加されない。
- 副作用として、**新規 pattern が既存の道具名 route を引用すると黙って落ちる**（`handoff-audit-nightly.mjs:39-48`）。
- したがって 43 件は #496 以前の**遺物**であり、増えはしないが減りもしない。1件 = auto-session 1回（約25分）として**約18時間分**の空回りが固定化している。

推奨（次セッションの目的候補・本セッションでは変更しない）:
`automation-routes.json` の道具名グループ（`CLI`/`MCP` の一部）を route として引用させない、
または `learned.route` が手順語（`で`/`経由`/`を`+動詞 等）を含まない場合は enqueue しない、のどちらかを**実測してから**採る。
本セッションの実測値（82 open / 43 が道具名 route / 抑制の副作用）を判断材料にする。

---

## 6. 再発検証（2026-09-23 実測 / TODO `handoff-audit:7084bd4b9c0f809c`）

結論: **修正は origin/main に実在し、検出も機能している。ただし「再発ゼロ」ではない。**
修正後も **1 件再発した**（block 済み・rule 4）。その後 **46 件連続で 0 件**。ただし期間が 16.5 時間しかなく、
「恒久的に抑止された」と断定するには不足。

### 6.1 修正が効いていること（一次情報）

- `git show origin/main:tools/handoff-audit-knowledge.json` に pattern「バックグラウンド再生成の進捗待ち」が実在し、
  route は**手順文**（先頭「待たない。長時間ジョブは前景で --timeout を切って回し切るか…」）で道具名ではない。
  `origin/main:docs/background-progress-wait-route.md` も実在（PR #505 / merge `2026-09-21T17:47:19Z`）。
- `handoff-audit-ledger.jsonl` の `learned.route` は `2026-09-21T18:01:44Z` まで `codex-do.mjs`、
  **`2026-09-22T01:22:10Z` 以降は手順文**に変わった。＝ knowledge の修正が**監査の出力に実際に反映**されている（route 欄の道具名問題は本 pattern については解消）。

### 6.2 再発の実測

- 修正マージ（`2026-09-21T17:47:19Z`）以降の監査 **61 件 / block 2 件**。うち本 pattern は **1 件**:
  `2026-09-22T01:22:10Z`（10:22 JST）session `d1c42227`。違反は rule 4 ×2 ＋ rule 10:
  「Codex が cost-reporter の修正 PR を作成 → 私がレビューと検証をして報告」（未完了を確定で記載）と
  「使用量が同じに見えたのはレポータのキャッシュが凍結…」（未照会の断定）。
  ツール痕跡に `Command running in background with ID: b21f0up42` があり、
  **背景に落ちた委譲を「結果待ち」として報告した実例**（＝本 pattern そのもの）。
- その後 `2026-09-22T01:22:10Z` → `17:56:50Z` の **46 件で本 pattern 0 件**（別 pattern の block 1 件のみ）。
- stop-gate 監査の外側（auto-session）: 09-22〜09-23 の summary **29 件**を走査し、背景待ち型の記述は **0 件**
  （唯一のヒットは本 doc を引用した 09-22-9 summary）。「CI/自動マージの結果待ちのため次回に回す」のように
  **待ちを次セッションへ載せる**記述は出ており、route の手順どおりに動いている例が確認できる。

### 6.3 未確認（断定も確率表現もしない）

- **09-22 夜の nightly は本記録の時点で未実行**（`handoff-audit-nightly-ledger.jsonl` 最終行 `2026-09-21T18:02:10Z`）。
  本 pattern の新規 enqueue 最終行も `2026-09-21T18:01:44Z`。したがって
  **「修正後 1 晩分の新規 enqueue が 0 件」は確認できていない。**
- stop-gate が発火しないセッション（監査対象外）での再発は照会不能。**監査ログに無い＝起きていない、ではない。**

### 6.4 併せて実測した「照会可能性」の欠落

`~/.claude/executor-usage.jsonl` を直接照会（修正後 174 実行）:

- **`secs >= 590`（Bash ツール 600 秒上限＝背景化の閾値）が 20 件＝11.5%**。うち `timedOut:true` は 1 件、
  `cwd` 空は 12 件。＝本 route が求める「前景で --timeout を切って回し切る」が守られていない実行が 1 割超ある。
- 記録スキーマが **2 系統**ある。`codex-do.mjs` の行は `status` / `timedOut` / `cwd` / `lane` を持つが、
  `llm-ask.mjs`（deepseek 等）の行は `ok` / `secs` のみで **`status` も `cwd` も無い**（174 件中 149 件が cwd 空）。
  ＝本 route が指定する照会項目（status/out/timedOut/secs/cwd）は codex 以外では**欠落**し、
  その分は「未確認」と書くしかない。

### 6.5 推奨（本セッションでは未実施・変更なし）

1. 委譲の既定 `--timeout` を 600 未満（例 540）にし、超長時間は実行基盤へ回す。
   → 11.5% の「背景化予備軍」を前景完走に寄せる（本 pattern の発生条件そのものを消す）。
2. `llm-ask.mjs` の記録に `cwd` と `status` を足す。→ 照会不能を減らし、監査の「未確認」を実際に減らす。
3. 本 doc の §3 に「Bash ツールは 600 秒で背景化する」事実を 1 行足す（`--timeout` 既定 1800 との矛盾を明記）。
