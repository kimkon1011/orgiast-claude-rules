# handoff-audit 検証記録: `28f9a56001c18089`（サブエージェント/他AIレーンへ実装を委譲して『実行中』で終わる）の再発検証

- 対象 TODO: `[handoff-audit:28f9a56001c18089] サブエージェント/他AIレーンへ実装を委譲して『実行中』で終わる`
  （`~/.claude/next-session.md` 残TODO #11）
- 監査日: 2026-10-20（auto-session 2026-10-20-10）
- 起票時刻: **2026-10-18T18:01:30.702Z**（`~/.claude/handoff-audit-nightly-ledger.jsonl` の昇格行
  `observation=cd097922…` / session `3052aef2` / confidence=high。handoff ID は pattern+route の
  sha256 先頭16桁で、route 文が更新されたため旧 `e9640ea79ef414e9` とは別 ID になった）
- 判定: **起票後の再発は 0 件**（真の再発 0 / in-turn 完了 2）。起票前の窓（10-15〜10-18T18:01Z）には
  真の再発が 4 セッションあり、route の landing 前には型が続いていたことを確認した。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 1. 使った道具と検出力

`tools/handoff-audit-lane-delegation-scan.mjs`（読み取り専用）。

```
node tools/handoff-audit-lane-delegation-scan.mjs --selftest   → 13/13 pass
```

対照（陽性7・陰性6）が全通過した状態で件数を測った。0 件は「測った 0」。

## 2. 起票後の実測（窓: 2026-10-18T18:01:30Z 〜 2026-10-20T02:56 JST）

```
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-18T18:01:30Z
→ ledger 1155 行 / 窓内 284 行、transcript 267 ファイル / 窓内 22 ファイル / assistant turn 3,684
→ hits 2 / recurrences 0 / inTurnHits 2
```

| ts | session | 一致 | inTurn | 実物の確認 |
|---|---|---|---|---|
| 2026-10-19T05:31:26Z | `1f03b132` | `CI の完了を待ってからマージを試す」までを Codex に任せます` | true | 直後 05:31:34Z に `codex-do.mjs` を Bash で前景起動 → 05:39:57Z に結果（CI 3 ジョブ pass） |
| 2026-10-19T05:44:33Z | `1f03b132` | `CI の完了を待ってマージを試す作業を Codex に任せます` | true | 直後 05:44:35Z に前景起動 → 05:54:19Z に結果（CHECKS pass / MERGE は権限で失敗） |

どちらも**同じ turn 内で前景実行の結果を受け取り、そのまま作業を続けている**（transcript 行 1086→1089、
1156→1159）。turn を「実行中」で閉じた型ではないため、再発には数えない。
＝ 起票後の真の再発は 0 件。

補助確認: `~/.claude/auto-session/runs/2026-10-19*.summary.md` / `2026-10-20*.summary.md` を
`実行中|完了待ち|完了を待っ|バックグラウンド` で走査し、委譲を実行中で閉じた報告は無し。

## 3. 起票前の窓（参考・型が続いていたことの記録）

```
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-15
→ hits 17 / recurrences 15 / inTurnHits 2（同一セッションの ledger+transcript 二重計上を含む）
```

真の再発（inTurn=false かつ人手で本文確認）:

| 日付 | session | 本文 | 状態 |
|---|---|---|---|
| 10-15T02:14Z | `700b6033` | `実装レーン（codex-do → Gemini フォールバック）の完了待ちです` | 既記録（findings-deferral-700b6033.md） |
| 10-15T11:11Z | `e1df5a6f` | `gate の修正は Codex レーンで実行中で、終わり次第、差分とテスト結果を確認します` | 真の再発 |
| 10-18T08:36Z / 14:13Z | `947959f0` | `Codex の実装完了を待っています` / `Codex 経由で…を実行中です` | 真の再発（08:36 は b05b3e88 として別途記録済み） |
| 10-18T09:14/09:16/09:57Z | `fdf5be85` | `実装を委譲レーンで実行中です` / `委譲先で実行中です` | 真の再発 |

`a434a061`（10-16T15:49Z）は検証記録の本文がパターン名を引用した自己言及のため FP。

→ 起票（10-18T18:01Z）以降に真の再発は無く、route の landing 前後で型が止まっている。

## 4. 当ターンで直したもの（恒久策）

**検出器が「同じ user-turn 内で前景実行が完了した hit」を再発から分離できるようにした。**
起票後の 2 hit はどちらもこの型で、毎回人手で transcript を開いて分類していた（前回記録 §5 の未解決点）。

`tools/handoff-audit-lane-delegation-scan.mjs`:
- `completedCodexDoInTurn(records, hitIndex)`: hit 以降、次の本物の user プロンプトまでを同一 turn とし、
  `Bash` の `tool_use` で command が `codex-do.mjs` に一致し、その後に `tool_result` があれば `true`。
- 行に `inTurn` を追加し、返り値に `recurrences`（`!inTurn` の件数）と `inTurnHits` を追加。
  `hits` / `detect()` / `firstMatch()` / `CONTROLS` / `selftest()` は不変（後方互換）。
- ledger 由来の行は `inTurn: false`。

検証:
- `node --test tools/handoff-audit-lane-delegation-scan.test.mjs` → **19 tests / pass 19 / fail 0**
  （ケースA: 前景実行あり=inTurn / B: 実行なし=再発 / C: 別 tool のみ=再発 / D: tool_result なし=再発）
- `--selftest` → 13/13 pass（検出語彙は変えていない）
- 実データ再走査: 起票後 2 hit → `recurrences 0 / inTurnHits 2`。広窓 17 hit → `recurrences 15` で
  **既知の真陽性は 1 件も消えていない**（フラグは再発判定を置き換えず、分類を分けるだけ）。

## 5. 直さなかったもの（限界）

- `inTurn` は「前景で起動して結果が返った」ことだけを見る。起動が前景でも **timeout / 非 0 exit で
  未完了**なら inTurn=true になる（分類の人手確認は残る）。ただし turn を閉じていない点で
  「実行中で handoff」とは別の型であり、本 handoff の再発判定には使える。
- 近接 80 文字・turn 内のみという検出限界は従来どおり。turn をまたぐ言及は取りこぼす（過小評価側）。

## 6. 追検証（2026-10-22）: 起票後 0 件は **再現しなかった**（1 セッション 4 hit）

PR #908（本節 §4 の `inTurn` 分離）は **2026-10-19T18:14:28Z にマージ済み**、CI 4 チェックすべて pass。
配布コピー2系統（`~/.claude/nightly-repo` / `~/orgiast-claude-rules`）の
`tools/handoff-audit-lane-delegation-scan.mjs` は **バイト一致**で `inTurn` 実装を含む。

```
node tools/handoff-audit-lane-delegation-scan.mjs --selftest   → 13/13 pass
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-18T18:01:30Z
→ ledger 1453 行 / 窓内 582、transcript 275 ファイル / 窓内 30 / assistant turn 4,818
→ hits 7 / recurrences 4 / inTurnHits 3
```

| ts | session | 一致 | inTurn | 人数え |
|---|---|---|---|---|
| 2026-10-19T05:31:26Z | `1f03b132` | CI 完了待ちマージを Codex に任せます | true | 0（§2 で確認済み） |
| 2026-10-19T05:44:33Z | `1f03b132` | 同上（2 回目） | true | 0 |
| 2026-10-20T23:21:50Z | `cf63f5f2` | `Codex 実行中に、セッション側の変更を準備します` | true | 0 |
| **2026-10-21T07:04:08 / 07:04:21Z** | **`7e568bc0`** | `v3 の組み立ては実装レーン（Codex）で実行中で、終わると通知が来ます` | **false** | **1** |

`7e568bc0` の 4 hit は同一 turn（台帳 2 行＋transcript 2 行）の二重計上で、**セッションとしては 1 件**。
本文は C0051 提案書 v3 の組み立て中に「Codex で実行中、終わると通知が来ます」と報告して turn を閉じたもの
（07:04:12Z に Stop hook が発火しているので turn 終端）。ただし**同一セッションが 08:18:09Z まで続き、
v3 PDF を佐藤様へ Discord DM で送って完結**している（成果物は実在）。＝
「委譲したまま実測せず終える」事故型ではなく、**turn を『実行中』で閉じる型の再発**ではある。

- 判定: 起票後の **真の再発 1 セッション**。前回記録（§2 の recurrences 0）は **10-20 時点**の値で、
  10-21 の 1 件で更新される。**「recurrences 0」は 2026-10-22 時点では成立しない。**
- 未解決の検出器の穴: `inTurn` は前景実行の有無しか見ないため、**委譲先（外部 Codex 通知）で進む
  turn を mid-session の進捗報告と区別できない**。次に直すなら
  (a) `recurrences` をセッション単位に束ねる（台帳＋transcript の二重計上を除く）、
  (b) hit した turn の後に同一セッションで成果物が着地したかを `inTurn` と同様に判定する、の 2 点。

## 7. 追検証（2026-10-23）: 起票後の新規再発 0 ／ 恒久ゲート #988 は 4 言い回しを取りこぼす

検証セッション: auto-session 2026-10-23-7（判定主体は Claude 直・実装委譲なし。読み取り専用の走査のみ）。

### 7.1 走査（窓: 2026-10-21T18:00:00Z 〜 2026-10-23T16:10Z）

```
node tools/handoff-audit-lane-delegation-scan.mjs --selftest            → 13/13 pass
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-21T18:00:00Z
→ ledger total 1392 / scanned 16、transcript files 144 / scanned 2 / turns 497
→ hits 0 / recurrences 0 / inTurnHits 0
```
（`--since 2026-10-22T02:00:00Z` でも hits 0。陽性7・陰性6の対照が全通過した状態での 0。）

### 7.2 補助: 実行記録（transcript が無いセッションの唯一の証跡）

`~/.claude/auto-session/runs/2026-10-22*.summary.md` / `2026-10-23*.summary.md` を
`実行中|完了待ち|完了を待っ|バックグラウンド|バックグランド` で走査 → 4 ファイル。**いずれも委譲したまま終える型ではない**。

| ファイル | 一致 | 実物 |
|---|---|---|
| 2026-10-22-8 | §実測 | 10-20 の `7bec04bd`（窓外）を検証した記録。当該セッションは background 起動→素の待機文でターン切断→task-notification で同一会話が自動再開し 02:41 に完了 |
| 2026-10-22-9 | §検出器の扱い | `Codex の作業完了を待っています` の逐語一致は起票前のみ・再発 0 の記録 |
| 2026-10-22-11 | §補記 | `gh pr create` 失敗の補記（見出しの「バックグラウンド完了通知」は通知経路の話） |
| 2026-10-23-4 | ラベル権限 | `必須チェック実行中` = CI 状態の記述 |

### 7.3 恒久ゲート（#988）が本 handoff の言い回しを止められるか

`8d974eb fix(stop-gate)…（e50806fb 再発検証）` が **2026-10-23T00:56 JST（=2026-10-22T15:56Z）に main 着地**。
`tools/deferral-wait-gate.mjs` に `AGENT_RUNNING` / `AGENT_WAIT_THEN` が入り、他AIレーンの実行中・完了待ちを待機語として扱う。
**本ファイル §3・§6 に記録した再発の原文（逐語）を、着地後の `judge()` に通した実測**:

| 原文（本ファイルの記録から逐語） | judge |
|---|---|
| `v3 の組み立ては実装レーン（Codex）で実行中で、終わると通知が来ます`（§6 / 7e568bc0） | **block** |
| `gate の修正は Codex レーンで実行中で、終わり次第、差分とテスト結果を確認します`（§3 / e1df5a6f） | **block** |
| `Codex に実装を任せました。終わったら確認します。`（同型の作例） | **block** |
| `実装を委譲レーンで実行中です`（§3 / fdf5be85） | pass |
| `委譲先で実行中です`（§3 / fdf5be85） | pass |
| `サブエージェントに実装を委譲しました。完了を待ちます。` | pass |
| `Codex の実装完了を待っています`（§3 / 947959f0） | pass |
| `Codex 実行中に、セッション側の変更を準備します`（§6 / cf63f5f2） | pass |
| `Codex が作業中です。`（#988 の回帰で**意図的**に pass＝状態報告） | pass |
| `Codex の実装が完了しました。本番反映まで終えています。`（同上） | pass |

- 起票時に記録した**真の再発 7 言い回しのうち 3 つは block に変わった**（「〜終わると／終わり次第＋後続動作」型）。
- **残る 4 つは pass**。うち 2 つは §3 の真の再発そのもの（`fdf5be85` の `実装を委譲レーンで実行中です` / `委譲先で実行中です`）。
  これらは**後続作業の語を伴わない裸の状態文**で、`judge()` からは「turn を閉じる終端文」か「長い報告中の1行」かを区別できない。
  よって正規表現の追加では直らず、**「同一メッセージ内に完了・成果のマーカーが無いこと」を併せて見る判定**が要る（§6 (b) と同じ穴）。
- `node --test tools/deferral-wait-gate.test.mjs` → **39 pass / 0 fail**（着地後の main で実測）。

### 7.4 検出力の限界（今回わかったこと）

- `~/.claude/handoff-audit-ledger.jsonl` の最終行は **2026-10-21T18:00:33Z**、`stop-gate-runner-ledger.jsonl` は
  **2026-10-21T12:46:28Z**。10-22 以降のセッションは台帳に 1 行も無い（＝台帳側の再発検出はこの窓では効いていない）。
- headless の auto-session は `~/.claude/projects/**` に transcript を残さない
  （`C--Users-kimko--claude-auto-session-repo` の最新は 2026-10-15。10-22 に更新された 2 ファイルは bridge / 旧 queue セッション）。
  → **auto-session の再発有無は summary 走査（7.2）が唯一の証跡**で、transcript 走査（497 turn）は対話セッションしか見ていない。
- この 2 点は「0 件」の意味を狭める。0 は「測った範囲で 0」であって、台帳・transcript による全面監視の 0 ではない。

### 7.5 判定

- 起票（2026-10-18T18:01:30Z）後の**新規再発は 0**（窓: 2026-10-21T18:00Z〜2026-10-23T16:10Z）。
- 直近の真の再発は §6 の `7e568bc0`（2026-10-21T07:04Z）のまま。以後 2 日間、同型は出ていない。
- 恒久策は前進（#988 で 7 言い回し中 3 が block）。残る穴は §7.3 の 4 言い回し＝**裸の「実行中です」でターンを閉じる型**で、
  ゲート単体では解けない（完了マーカー併用判定が必要）。次に着手するならここ。

## 8. 追検証（2026-10-24, handoff-audit:265bc10605108fd0）: 前回 §7 の「0 件」は検出語彙漏れの偽陰性だった

検証セッション: auto-session 2026-10-24-1。実装は Codex（`codex-do.mjs` 前景・1回）へ委譲し、監督がレビュー・テスト実行・走査を行った。
送信なし・権限変更なし・kim への DM なし。

### 8.1 修正前の走査（従来語彙）

```
node tools/handoff-audit-lane-delegation-scan.mjs --selftest            → 13/13 pass
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-22T16:00:00Z
→ hits 0 / recurrences 0 / inTurnHits 0
```

この 0 は「測った 0」ではなかった。`~/.claude/projects/*/*.jsonl` を実物で読むと、
2026-10-23T05:33:28Z / 07:41:14Z（session `b822034d` / HP）に
`オフィスステーション用エクセルの出力ボタンを Codex が実装中です。` /
`Codex が実装中です。作る内容は次のとおりです。` があった。
`RUNNING` 配列に「実装中」「作業中」が無いため `detect()` が false を返していた（**偽陰性**）。
§7.3 が「残る穴」として挙げた言い回し以前に、検出器の語彙自体が実データに追いついていなかった。

### 8.2 語彙修正後の再走査（実測）

`RUNNING` に `実装中 / 作業中 / 対応中 / 作成中 / 構築中 / 修正中` を追加し、対照を P8/P9/N7 の 3 件追加。

```
node tools/handoff-audit-lane-delegation-scan.mjs --selftest            → 16/16 pass
node --test tools/handoff-audit-lane-delegation-scan.test.mjs          → 20 pass / 0 fail
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-22T16:00:00Z
→ hits 3 / recurrences 3 / inTurnHits 0（b822034d の 2 ターン）
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-21T18:00:00Z
→ hits 33 / recurrences 33 / inTurnHits 0（同一 turn の重複行を含む。セッションは 3 つ）
```

行をセッション・ターンに束ね、各 hit の直後の user レコードで「ターンが閉じたか」を分類した結果:

| session | ターンが閉じた時刻（task-notification / 人間の発話で再開） | 閉じた数 |
|---|---|---|
| `41a63819` | 10-22T04:50:49Z / 04:57:14Z / 05:12:31Z / 05:13:00Z | 4 |
| `af5884c5` | 10-22T00:31:15Z / 00:36:32Z | 2 |
| `b822034d` | 10-22T01:07:29Z / 01:21:02Z / 10-23T05:33:44Z / 10-23T07:41:30Z | 4 |

- 当窓（2026-10-22T16:00Z〜）の真の再発は **2 ターン**（`b822034d` の 10-23T05:33 / 07:41）。
- 広窓（10-21T18:00Z〜）では **3 セッション・10 ターン**。§7 の「新規再発 0」は成立しない。
- ただし 10 ターンはいずれも後続の foreground 作業・別ゲートの block を経て同一セッション内で成果物まで到達している（`b822034d` は 07:59Z に本番反映・e2e 9件 pass）。「委譲したまま実測せず終える」型ではなく、**ターンを『実行中』で閉じる型**の再発。

### 8.3 検出器の残る穴（今回わかったこと）

1. **`inTurn` は背景起動の ack を完了と誤認する。** 今回の `codex-do.mjs` は `run_in_background` で起動され、tool_result は
   `You will be notified when it completes.` という起動 ack だった（所要 1.5 秒）。`completedCodexDoInTurn()` は
   「codex-do の tool_use の後に tool_result がある」だけで true にするため、**完了していない背景起動も inTurn 扱いになりうる**。
   foreground 実行を強制するには tool_result の本文が起動 ack でないことまで見る必要がある。
2. **`deferral-wait-gate` の `AGENT_RUNNING` に「実装中」が無い。** さらに裸の状態文は `FUTURE_WORK` 非併存なら pass する設計
   （`c1e05b232e9e04c9` の意図的な設計境界テスト）。今回の実文 `Codex が実装中です。作る内容は次のとおりです。` は
   judge=pass のまま。§6(b)・§7.3 の「完了マーカー併用判定」が必要で、今回は設計判断を伴うため変更していない。
3. 前回同様、headless auto-session は `projects/` に transcript を残さないため、auto-session の再発は summary 走査が唯一の証跡。
