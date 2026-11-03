# レーン委譲 handoff 再検証（2026-10-24 実測 / handoff-audit:4f673aa74dd84313）

対象 handoff: 「他AIレーンへ実装を委譲して『実行中』で終わる」
前回監査: `tools/handoff-audit-findings-lane-delegation-28f9a560.md` §7（2026-10-23）
関連 PR: #1046（同じ型の検出語彙を是正。2026-10-24 00:55 JST 時点で OPEN・`test-posix` が IN_PROGRESS のまま）

判定主体は Claude 直。実装のうち検出器の改修2件は `tools/codex-do.mjs` を**前景・単発（`--timeout 420` / `--timeout 300`）**で
実行し、当ターン内に exit 0 と差分を受け取って検証した（バックグラウンド起動なし。turn を「実行中」で閉じていない）。

## 1. 結論

- 窓 **2026-10-21T18:00Z〜2026-10-24T00:50Z** で、同型の**真の再発は 0 セッション**。
- 検出器は 6 行 / 3 セッションを hit したが、人手で transcript を読み、3 セッションとも
  **同じ turn 内で委譲先の完了結果を受け取り、成果物を検証してから報告を終えている**ことを確認した。
- うち 2 セッションは検出器の**既知の穴**（turn 境界と完了証拠の扱い）で `inTurn=false` に誤分類されていたため、
  当ターンで検出器を直した（§4）。是正後は transcript 由来 3 行が `inTurn=true`、ledger 由来 3 行は
  transcript の tool 情報を持たないため `inTurn=false` のまま（同一セッションの二重計上）。

## 2. 走査（`--selftest` 13/13 pass の状態で測定）

```
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-21T18:00:00Z
是正前: ledger 871 行 / 窓内 292、transcript 55 ファイル / 窓内 22 / 5,309 turn
        hits 8 / recurrences 8 / inTurnHits 0
是正後: hits 6 / recurrences 3 / inTurnHits 3
```

| ts (UTC) | セッション | 一致 | 是正後 inTurn | 実物の確認 |
|---|---|---|---|---|
| 2026-10-22T00:36:32/35 | `af5884c5` | `Codex が実行中` | true | 00:36:15 に `codex exec` 起動 → 00:37:32 の `<task-notification> status=completed` を受領 → 00:37:43 に「全項目合格」、00:44:19 までに検証・報告完了 |
| 2026-10-22T04:50:23/28/49/54 | `41a63819` | `Codex に実装を投げました（背景実行）。完了通知を待` | true | 04:47:57 起動 → 04:50:02 に exit 0 の tool_result → 04:50:54 の task-notification completed → 04:51:13 に「何も書けなかった」と判定し指示書を直して再委譲 → 05:01 に 785 passed、05:35 に本番反映まで確認 |
| 2026-10-23T15:48/49 | `3ef4d6d1` | `待機プロセス…cheap-code` | （検出から除外） | Codex ログインの完了報告。`待機プロセス` はログイン待ちの子プロセスで、委譲の実行中ではない＝偽陽性 |

- `af5884c5` は 00:31〜00:36 にも「Codex が実装中です」と進捗を書いているが、いずれも同じ turn の途中で、
  00:37 に結果を受けて作業を続けている。turn を閉じたまま放置した型ではない。
- したがって **「委譲したまま実測せず turn を終える」型の再発は 0**。

## 3. 前回記録（§7.1）との不一致（未確認のまま記録）

前回監査（2026-10-23）は同じ `--since 2026-10-21T18:00:00Z` で `hits 0`・`ledger total 1392`・
`transcript files 144 / scanned 2` と記録している。今回同じコマンドは `ledger total 871`・
`transcript files 55 / scanned 22` で、10-22 の 6 行を返す。**台帳の行数が減り、transcript のファイル数も減っている**ため、
同一の一次記録に対する測定ではない。台帳のローテーション／再生成のどれが起きたかは**未確認**（この窓では判定材料が無い）。
前回の「0」を今回の「0」の根拠には使わず、今回の実測だけで判定した。

## 4. 当ターンで直したもの（恒久策・検出器の精度）

`tools/handoff-audit-lane-delegation-scan.mjs`:

1. **turn 境界**: `isRealUserPrompt()` が文字列 content を無条件に本物の user プロンプト扱いしていたため、
   `Stop hook feedback:` / `<task-notification>` / `<system-reminder>` / `[HANDOFF-REGRET]` で turn が切れていた。
   これらを注入メッセージとして除外。
2. **委譲起動の範囲**: hit 以降だけでなく **同一 turn 内の全 `Bash` tool_use** を見る。
   起動コマンドの一致語を `codex-do.mjs` から `codex exec` / `cheap-code.mjs` まで広げた。
3. **完了証拠**: hit 後の (a) 前景 `tool_result`（起動直後の「バックグラウンドで実行中 ID」は除外）または
   (b) 同じ `<tool-use-id>` を持つ `<task-notification>` の `<status>completed</status>` を完了とみなす。
4. **偽陽性**: ログイン待ちの `待機プロセス` を検出ノイズとして除去（RUNNING 語 `待機` との近接共起を防ぐ）。

検証:
- `node --test tools/handoff-audit-lane-delegation-scan.test.mjs` → **25 pass / 0 fail**（既存13対照は不変）
- `--selftest` → **13/13 pass**
- 実データ再走査: hits 8 → 6、偽陽性 1 行を除外、transcript 由来 3 行が `inTurn=true`。

## 5. 限界（「0」の意味）

- ledger 由来の行は tool_use / tool_result を持たないため、常に `inTurn=false` になる。
  **再発の有無は transcript 側の `inTurn` と人手確認で判定する**（台帳の `recurrences` をそのまま再発数にしない）。
- 同一セッションの台帳＋transcript 二重計上は残る（セッション単位の束ねは未実装）。
- transcript が残るのは対話セッションのみ。headless の auto-session は `~/.claude/projects/**` に残らないため、
  auto-session の再発有無は `runs/*.summary.md` の走査が唯一の証跡。
- 背景起動の `tool_result` を除外する判定は文字列一致（`running in background` 等）に依存する。
  文言が変われば前景扱いに戻る可能性がある。

## 6. 残ったこと

- PR #1046（検出語彙に `実装中`/`作業中` を追加）は OPEN のまま `test-posix` が IN_PROGRESS で止まっている。
  本 PR の差分とは独立だが、同じファイルを触るため、#1046 が先にマージされた場合は軽い rebase が要る。
- 次回の監査では、本ファイルの是正後スキャナで `--since` を今回の窓末（2026-10-24T00:50Z）にして再走査し、
  `inTurn=false` の transcript 行だけを人手確認する。
