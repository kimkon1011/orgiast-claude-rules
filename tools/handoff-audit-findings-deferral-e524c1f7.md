# handoff-audit 検証記録: `e524c1f72f058577`「Codex 等の他AIレーン待機が期限切れ→Claude 本体で続行」の再発検証（2026-10-22）

対象 TODO: `[handoff-audit:e524c1f72f058577] Codex等の他AIレーン待機が期限切れ→Claude本体で続行 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: codex-do.mjs）`。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

## 結論

1. **逐語の再発は 0 件。** 原文発生 `2026-10-20T00:37:39Z` 以降の 3 台帳と transcript 91 ファイルを走査し、
   「レーンの待機・見張り」と「期限切れ・タイムアウト」が共起する行は**原文 1 行だけ**。
   transcript の assistant 428 turn でも同じく 1 件（原文）のみ。
2. **同型の「委譲して完了待ち」は 13 行あるが、期限切れを含むものは 0。** いずれも 2026-10-20〜21 の
   `Codex の完了待ち` で、`deferral-wait-gate` の #959 / #962 で block 化済みの型。今回の「期限切れ→本体続行」とは別。
3. **原文のターン自体は、待機の期限切れ後に本体作業をしていない。** Codex はその前に終了コード 0 で完了しており、
   本文も「この通知では何もしません」と書いている。失われたのはレーンではなくターン（同セッションの
   `ccdb575d` = 返信待ちは別 TODO で処理済み）。
4. **再発防止の経路（codex-do.mjs）は実物で生きていた。** `lane-doctor --probe` は codex を
   `auth_ok:probe_ok` で生存判定、`codex-do --dry-run` は `route=codex / executor=codex / model=gpt-5.6-sol` を返す
   （2026-10-22 実測・前景経路。フォールバックに落ちていない）。
5. **リアルタイムゲートの穴を塞いだ。** 従来の `lane-abandonment-gate` は「失敗シグナル + Opus/Fable」が前提で、
   期限切れは失敗シグナルではないため素通りした。`tools/lane-abandonment-gate.mjs` に
   「レーンの待機が期限切れ → 本体で実装・続行」の近接判定を追加し、原文（本体作業なし）は pass のまま、
   再発形は block することをテストで固定（42 tests pass）。

## 1. 原文（一次証拠）

`~/.claude/handoff-audit-nightly-ledger.jsonl` の `2026-10-20T18:00:40.838Z` 行（session `bdbf73fd-ef5d-4753-ac71-0531fd566e29`）:

```
verdict: block
rule 9 quote: 「Codex の終了を待つために仕掛けていた見張りが期限切れになったという自動通知で、kim さんからの返信ではありません。」
fix: 他AIレーンの失敗・待機でClaude本体(Opus)に戻るのはrule 13違反。lane-doctorで復旧し生存レーンへ再委譲する。
     待機の期限切れを理由にFable/Opusで作業を続けない。
learned: { pattern: "Codex等の他AIレーン待機が期限切れ→Claude本体で続行", route: "codex-do.mjs", confidence: "high" }
```

この learned が `~/.claude/handoff-audit-promotions.jsonl`（`2026-10-20T18:00:40.827Z`）で
`route=codex-do.mjs` として昇格し、本 TODO になった。

原文 turn は `2026-10-20T00:37:39.306Z`。当時のリアルタイム判定は
`stop-gate-runner-ledger.jsonl`・`handoff-audit-ledger.jsonl` とも `pass`、夜間監査だけが `block`。
本文（全文）:

> 今届いたのは、Codex の終了を待つために仕掛けていた見張りが期限切れになったという自動通知で、
> kim さんからの返信ではありません。Codex はその前に終わっていて、結果も確認済みなので、
> この通知では何もしません。
>
> まだ commit も本番反映もしていない状態で、「続けて」の返信を待っています。
> 次に kim がすること: 「続けて」と返す

同じセッションの `2026-10-20T01:09:17Z` に「Codex が終わりました（終了コード0）」があり、
期限切れの時点でレーンは既に完了していた。**待機の期限切れを理由に本体実装へ戻った事実は無い。**
夜間監査の rule 13 判定は「待機で本体に戻る」型の予防線として妥当だが、この turn の実害は
返信待ち（`handoff-audit:ccdb575d6523f44a` / PR #965 で処理済み）側にある。

## 2. 再発走査（2026-10-20T00:37:39Z 以降・2026-10-22 実測）

| 台帳 | 全行 | 窓内 | 「待機/見張り」該当 | 待機 × 期限切れ |
|---|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 314 | 202 | 23 | 1（原文のみ） |
| `handoff-audit-ledger.jsonl` | 547 | 326 | 25 | 1（原文のみ） |
| `handoff-audit-nightly-ledger.jsonl` | 23 | 22 | 2 | 1（原文のみ） |
| `~/.claude/projects{, -archive}/**/*.jsonl`（assistant 428 turn / 91 ファイル） | — | — | — | 1（原文のみ） |

`tools/handoff-audit-lane-delegation-scan.mjs --since 2026-10-20T00:37:39Z` の結果:

```
ledger 547 行 / 窓内 326 行、transcript 49 ファイル / 窓内 8 ファイル・assistant 1,453 turn
hits 13 / recurrences 13 / inTurnHits 0、selftest 13/13
```

13 行の内訳は `c2976c47` `bdbf73fd` `a7673192` `b822034d` `4d7e4383` の
「Codex の完了待ち／検証を実行中」。**期限切れ・タイムアウトを含む行は 0**。
これらは 2026-10-21 に `deferral-wait-gate` の #959（届いたら／待ってから）と
#962（同型 5 件の回帰固定）で block 化済みの型で、本 TODO の「期限切れ→本体続行」ではない。

## 3. 再発防止の経路（codex-do.mjs）の実測

```
node tools/lane-doctor.mjs --probe
→ 生存: codex ✅ gemini ✅ deepseek ✅ groq ✅ openrouter ✅
   停止: glm ❌(missing_key) / gemini-cli ❌(probe_ok)
   implementOrder: ["codex","deepseek"] / repairs: []

node tools/codex-do.mjs "lane probe" --cwd <repo> --dry-run --timeout 60 --origin unattended
→ [codex-do] kind=implement origin=unattended route=codex
   executor=codex model=gpt-5.6-sol effort=default lane=default_sol
```

codex は認証込みで生存しており、待機の期限切れ後に本体へ戻る代わりに
`codex-do.mjs` を前景・`--timeout` 付きで回し直せる。フォールバック（deepseek）も生存。

## 4. 恒久修正（ゲート）

`tools/lane-abandonment-gate.mjs`:

- `expiredWaitBody(text)` を追加。「レーンの待機/見張り」と「期限切れ/タイムアウト」と
  「本体で実装・修正・作成・続行」が ±140 字以内で共起するときだけ一致を返す。
- モデルが Fable/Opus のとき、失敗シグナルが無くても `LANE-ABANDON` で block する
  （Sonnet セッションは従来どおり対象外、`[LANE-FALLBACK]` / `[LANE-REPAIR]` の明記は免除）。
- 原文（「期限切れの通知だが何もしない」）は本体作業が無いため **pass のまま**。
  期限切れ後に再委譲する文・テスト実行などの監督作業も pass。
- 回帰: `tools/lane-abandonment-gate.test.mjs` に 6 件追加。**42 tests / 42 pass**。

## 5. 判定

- 逐語再発: **0**（原文 1 行のみ）。
- 同型（期限切れ → 本体続行）の再発: **0**。
- 再発防止経路（codex-do.mjs）: **生存・前景で選択されることを実測**。
- ゲート: 再発形を block、原文と正当な再委譲・監督作業を pass で固定。
