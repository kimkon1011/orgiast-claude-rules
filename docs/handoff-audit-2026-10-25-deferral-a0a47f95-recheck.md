# handoff-audit:a0a47f951cb7f1a4 再発検証（2026-10-25）

## 対象

検出: **2026-10-23T02:25:45.629Z / session `7e3e8cde-171b-4456-aad5-b3dd2380e4f1` / P1**。

> ITERATING
>
> 修正後の実測はまだ取れていないため、判定は次回に持ち越します。
>
> 次に kim がすること: なし
> この後の自動進行: 次の夜間監査の後に台帳を再走査し、修正が本番で効いたかを確認します。
> このセッション: /session-close は不要なので、このセッションを閉じてよい

台帳上の実体（すべて実読）:

| 台帳 | 行 | 判定 | 備考 |
|---|---|---|---|
| `~/.claude/stop-gate-runner-ledger.jsonl` | 524 | `pass` | excerpt が原文と一致 |
| `~/.claude/handoff-audit-ledger.jsonl` | 1259 | `pass` | `fired=false` / `provider=null` |
| `~/.claude/handoff-audit-deferral-ledger.jsonl` | 22 | `P1` | `source=stop-gate-runner-ledger.jsonl` |
| `~/.claude/course-corrections-ledger.jsonl` | 1350 | `pass` | `gate=lane-abandonment` |
| `~/.claude/auto-progress-ledger.jsonl` | 236 | — | `status=waiting_user` / promise が上記「この後の自動進行」 |

原文の直前 3 秒（02:25:42.244Z / stop-gate 523）で同じセッションが
「イテレーション 5 では、修正が本番で効いたかを判定できませんでした」と報告し、
その 3 秒後に判定を次回へ回して閉じている。**先送りの実体は「修正 `f94ee7a` が本番で効いたかの実測」**で、
実装そのものは同セッションが 02:24:55Z にコミット済み（先送りより約 1 分前）。

## 1. 再発の有無: 原文の逐語は再発していない

走査: `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-23T02:25:45.629Z --json`
（本ブランチの検出器は origin/main と同一）。

| 台帳 | 窓内行数 | hits | 内訳 |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 631 | **36** | P1 1（原文）／P3 35（10-23: 34 / 10-24: 2） |
| `handoff-audit-ledger.jsonl` | 1528 | 0 | – |
| `handoff-audit-nightly-ledger.jsonl` | 45 | **3** | P3 3（すべて 10-23） |

- **P1 は原文 1 行だけ**。`判定は次回に持ち越` / `実測はまだ取れていない` は
  4 台帳（stop-gate・audit・deferral・course-corrections）で各 1 行、**すべて同一イベント**
  `2026-10-23T02:25:45.6Z` の写しで、原文セッションの外には 1 行も無い。
- 残る 38 行は**別型**（P3「`f94ee7a` を main にマージ／着地させる承認を kim に渡す」）。
  07:18〜07:24 の 8 セッションと 10-24T04:34／04:36 の 2 セッションで、最新は
  **2026-10-24T04:36:20.208Z / `61af55b9`**。この型は #1075（`89f3eea`・2026-10-24T16:04:05Z）で
  `isLandingDeferral` を配線済みで、監査 TODO は #1069・#1071・#1075・#1077・#1078・
  #1081・#1082・#1084 の 8 本で閉じている（本件は 9 本目）。
- **検出器修正の着地後は 0 行**: `--since 2026-10-24T16:04:06Z` と `--since 2026-10-25T00:00:00Z` の
  両方で 3 台帳とも P1〜P4・W が 0（hits=0）。
- 原文の言い回しは**現行の P1 でも検出できる**（実測: `detect(原文)` → `P1` /
  match=`修正後の実測はまだ取れていないため、判定は次回に`）。

### 限界

- 走査対象は台帳に残った `excerpt` / `violations[].quote` のみ。`tools/stop-gate-runner.mjs` が
  `excerpt` を先頭 **200 文字**で切るため、末尾フッターだけの先送りは台帳走査に出ない。
  上の 39 行は**下限**で、0 行は「先送りが無かった」証明ではない。
- 原文の判定は `pass`（Stop ゲートは通した）。この型を止めるのは夜間 P1 走査だけで、
  live の `deferral-wait-gate` / `next-action-gate` は原文を pass する（実測:
  `judgeNextAction(原文)` → `pass / valid-footer`、`deferral-wait-gate.judge(原文)` → `pass`）。
  先送り語がフッターではなく本文にあり、フッターが「なし」で正規のため。

## 2. 先送りの実体: 解消済み（main 着地＋当ターンで動作を実測）

- `f94ee7a`（`fix(stop-gate-runner): 先行gateが全て降格された場合に第2段の手渡し監査を再評価する`、
  author date 2026-10-23T02:24:55Z）は origin/main の祖先**ではない**（`merge-base --is-ancestor` exit 1）。
  ただし追加 5 行は **`origin/main:tools/stop-gate-runner.mjs:134-138`** に同一文言で存在する。
- その着地は **PR #1047**（`merged=true` / `merged_at=2026-10-23T15:44:34Z` /
  `merge_commit_sha=0449b88159f28f0c58e2da81713a3411d865bea7`、GitHub API で実読）。
  **kim の承認作業は残っていない。**
- 本番 hook（`~/.claude/nightly-repo`・クリーン）は HEAD `912b734`（origin/main 同期済み）で、
  `tools/stop-gate-runner.mjs:134` に同じ 5 行、`next-action-gate.mjs` と
  `permanent-fix-deferral-scan.mjs` に `isLandingDeferral` が実在する。
- **当ターンで第2段の動作を実測した**: `run()` を `mode:'block'` ＋ provider スタブで直接呼び、
  FORM_GATES だけで block する `reply-only` の手渡し文を入力 → `verdict=block` /
  `blockedBy=['handoff-audit-gate']` / provider 呼び出し 1 回。
  regex-blocked → 全降格 → 第2段だけが止める経路が期待どおり動く。
- ただし**本番台帳では、この分岐が自然発火した行は未観測**: `handoff-audit-ledger.jsonl` の
  `skipped=regex-blocked` は 406 行、`provider` 付きは 23 行、**両方を満たす行は 0 行**。
  よって「本番で効いたか」はコードの存在＋当ターンの直接実行で担保し、自然発火は今後の観測待ち。
- 再発防止として **回帰テストを追加**した（`tools/stop-gate-runner.test.mjs`
  「先行ゲートが全て降格された場合は第2段の監査で手渡しを止める」）。この分岐には
  従来テストが無く、着地後の回帰を検知できなかった。

## 3. 結論

1. 原文の逐語（P1）は**再発していない**（原文セッションの写し 4 行のみ）。
2. 同窓の P3 38 行は別型（`f94ee7a` の着地承認）で、検出器修正 #1075 着地後は 0 行。
   #1075 着地以降の窓（10-24T16:04Z〜／10-25T00:00Z〜）は全パターン 0。
3. 先送りの実体（修正が本番で効いたかの実測）は、実装が PR #1047 で main に着地し、
   第2段の動作を当ターンに直接実行して確認した。**kim が行う作業は無い。**
