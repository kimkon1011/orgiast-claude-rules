# handoff-audit 検証記録: 他AIレーンへの実装委譲をバックグラウンド起動で『実行中』のまま handoff × route「codex-do.mjs」（2026-10-25 再検証）

対象 TODO: `[handoff-audit:0efd29ab642ba570] 他AIレーンへの実装委譲をバックグラウンド起動で『実行中』のまま handoff`
前回監査: `docs/handoff-audit-2026-10-24-lane-delegation-recheck.md`（同型の検出器改修。`handoff-audit:4f673aa74dd84313`）
関連: `tools/handoff-audit-findings-lane-delegation-28f9a560.md` / `tools/handoff-audit-findings-lane-delegation-recheck.md`

id は `sha256(JSON.stringify([NFKC(pattern), NFKC(route)])).slice(0, 16)` で再計算し一致を確認した
（pattern `他AIレーンへの実装委譲をバックグラウンド起動で『実行中』のまま handoff` × route `codex-do.mjs` = `0efd29ab642ba570`）。

## 1. 結論

1. **handoff 自体の再発は 0。** 前回監査の窓末（2026-10-23T15:50Z）以降、台帳 64 行・transcript 1,311 assistant turn を走査して
   同型の真の再発は無い（§2）。スキャナの hit は 1 行だけで、前回監査セッション自身の完了報告（自己引用）だった。
2. **route「codex-do.mjs」は前景・単発で実際に動くことを当ターンに実測した**（§3）。`--dry-run` で `route=codex` を確認し、
   実際の委譲を `--timeout 240` で前景実行 → 当ターン内に exit 0 と差分 2 ファイルを受領。バックグラウンド起動は使っていない。
   この委譲で本監査の恒久修正（§4）を実装した。**＝route の実在確認と再発防止策の実装を同じ実行で兼ねた。**
3. **再発の原因の一つは「監査TODOの再起票ループ」だった。** knowledge には route `codex-do.mjs` の entry が既にあるのに、
   `enqueueTodos()` が next-session の TODO 行しか見ていなかったため、完了行がローテーションで退避されると
   同じ route の TODO を再起票していた（§4 で再現 → 修正 → 再現消滅を実測）。

## 2. 再発走査（実物・読み取りのみ）

窓 = 前回監査の終端 `2026-10-23T15:50:00Z` 〜 2026-10-25T01:00Z 頃。`--selftest` 13/13 pass を確認してから測定した。

```
node tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-23T15:50:00Z   # 既定 root
→ ledger total 935 / 窓内 64、transcript files 55 / 窓内 0、hits 0
（既定 root は ~/.claude/projects のみ。窓内ファイルが 0 なので両 root で再測定）
scan({since, roots:['projects','cheap-code-worker/projects']})
→ transcript files 162 / 窓内 17 / turns 1,311、hits 1、recurrences 1、inTurnHits 0
```

| src | ts (UTC) | session | 一致 | 判定 |
|---|---|---|---|---|
| transcript | 2026-10-23T16:06:35.927Z | `9522d3e0` | `委譲「実行中` | **再発ではない（自己引用）**。本文は前回監査の完了報告で「委譲『実行中』handoff を…再検証し、真の再発0セッションを確認」と書いたもの。対応する `runs/2026-10-24-4.summary.md` の mtime も同じ時刻。 |

- 真の再発（委譲をバックグラウンド起動し、完了を実測せず turn を閉じた）は **0 セッション**。
- 補助走査: `auto-session/runs/*.summary.md` の窓以降分（2026-10-24-1 〜 2026-10-25-3）に、委譲を実行中のまま残した報告は無い。
  2026-10-24-1 / 10-24-4 の「実行中」は当該監査自身の説明（Codex は前景 2 回・exit 0）、2026-10-20-1 / 10-22-10 の「実行中」は CI。
- `~/.claude/session-handoffs.md`・`next-session.md` にも、窓以降の新しい background 委譲 handoff は無い
  （`next-session.md` の一致 1 件は本 TODO 行そのもの）。

### 「0」の限界
- headless の auto-session は `~/.claude/projects/**` に transcript を残さない。auto-session 分は `runs/*.summary.md` の走査が唯一の証跡。
- 検出は 1 turn 内の語の近接共起。turn をまたぐ言及は拾わない（過小評価側）。

## 3. 経路「codex-do.mjs」の実物検証（HP / 2026-10-25 01:03–01:05 JST）

| 確認 | 方法 | 実測 |
|---|---|---|
| 実行計画 | `node tools/codex-do.mjs --dry-run "<指示>" --cwd ... --origin unattended --timeout 150` | `kind=implement origin=unattended route=codex` / `executor=codex model=gpt-5.6-sol`、**exit 0**。dry-run は子プロセスを起動しない |
| 前景実行 | `node tools/codex-do.mjs --prompt-file <指示> --cwd "C:\Users\test\.claude\auto-session-repo" --origin unattended --timeout 240` | **exit 0**・`[codex-do] executor=codex`・codex session `01a16ea7-67bf-70f0-8924-0eeb331841cb`。当ターン内に「指定どおり2ファイルのみ変更しました」を受領 |
| 実際に書けたか | `git status --porcelain` / `git diff --stat` | 差分は指示した 2 ファイルだけ（`tools/handoff-audit-nightly.mjs` +7/-3、`tools/handoff-audit-nightly.test.mjs` +5）。指示外の変更なし |
| 背景起動していないか | 実行ログ | バックグラウンド ID・task-notification 待ちは無し。Bash 呼び出しは前景で完結し、exit 0 を当ターンで受け取った |
| コード上の保証 | `tools/codex-do.mjs:992` 付近 | 子は `stdio:['pipe','pipe','pipe']` で spawn し、`close` で resolve する Promise を await（`:1023`）。子の `unref`/`detached` は無し（`timer.unref` はタイムアウト用タイマーのみ） |
| headless の禁止 | `tools/pretooluse-headless-background.mjs` + `settings.json:459`（gate-hook-runner 経由） | `CLAUDE_HEADLESS=1` で `run_in_background:true` と `ScheduleWakeup` を deny。`node --test tools/pretooluse-headless-background.test.mjs` = **5/5 pass** |

## 4. 恒久策（当ターンで実装・実測）

### 再現した穴
`handoff-audit-knowledge.json` には route `codex-do.mjs` の entry（pattern「Codex等の他AIレーン待機が期限切れ→Claude本体で続行」）が
既にある。しかし `enqueueTodos()` は **next-session.md の TODO 行の route しか重複判定に使っていなかった**。
完了行がローテーションで退避されると、同じ route の別 pattern が再び TODO として起票される。実測:

```
enqueueTodos('## 残TODO\n', [{pattern:'他AIレーンへの実装委譲をバックグラウンド起動で『実行中』のまま handoff', route:'codex-do.mjs'}])
→ 1. [handoff-audit:0efd29ab642ba570] …（再起票される＝本 TODO の発生源）
```

### 修正（`tools/handoff-audit-nightly.mjs`）
- `enqueueTodos(markdown, items, knownRoutes = [])` に第3引数を追加し、重複判定の初期集合を
  `new Set((knownRoutes || []).map(key))` にした（`key` は既存の NFKC 正規化）。
- `runNightly` から **merge 前の** `knowledge.map(k => k.route)` を渡す。新しく昇格した route まで抑制すると
  新しい経路の監査TODOが永久に作られなくなるため、merge 前を使う。
- deferral 用の `enqueueTodos(previous, enqueueRows.map(deferralTodo))` は route がセッションIDで一意なので変更しない。

### 修正後の実測
```
enqueueTodos('## 残TODO\n', [同項目], knowledge の全 route)
→ "## 残TODO\n"（TODO は追加されない）
新規 route は従来どおり追加される（テストで担保）
```

### テスト
- `node --test tools/handoff-audit-nightly.test.mjs tools/handoff-audit-lane-delegation-scan.test.mjs` → **46 pass / 0 fail**
  （追加: 「knowledgeに記録済みのrouteは抑制し、新規routeは追加する」= 既知 route・全角正規化・新規 route の3assert）
- `node --test tools/*.test.mjs` → **6,431 tests / 6,423 pass / 0 fail / 8 skipped**（duration 301.9s）
- 既存テストの期待値は変更していない（委譲先が緩めた形跡なし。差分を全行レビュー済み）。

## 5. 残る穴（未確認を明記）

- **interactive セッションでは `run_in_background` を禁止していない。** headless の deny は
  `CLAUDE_HEADLESS=1` のときだけ。対話セッションで codex-do を背景起動して turn を閉じる経路はツール境界では止まらない
  （報告文の `実行中` は `next-action-gate` の BACKGROUND_PATTERN と本スキャナが拾うが、起動自体は許可）。
  長時間（前景 10 分超）の委譲を許す既存運用とのトレードオフがあるため、今回は deny を広げていない。
- route の重複判定は**文字列の完全一致（NFKC 正規化後）**。LLM が同じ手段を別表記（例: `codex-do` や長文の説明）で
  route に書くと、今回の knowledge 照合をすり抜けて再起票され得る（コード読解。実測は未実施）。
- transcript の走査は HP のみ・窓以降に mtime があるファイルのみ。他PCと窓外は未走査。

## 6. B軸（人手・コスト）

- この検証で kim の手作業は 0（読み取り・前景委譲・テストのみ。送信・権限変更なし）。
- 同じ route の監査TODOが毎回再起票されるコストを1本分消した（knowledge 照合の追加）。次回以降は
  完了行がローテーションしても、knowledge に route が残る限り再起票されない。
