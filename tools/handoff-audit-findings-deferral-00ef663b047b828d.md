# handoff-audit 検証記録: `00ef663b047b828d`（W / 64c38ff9）の再発検証（2026-10-26）

対象 TODO: `[handoff-audit:00ef663b047b828d] 恒久修正の先送り文を検出（2026-10-25T01:11:14.426Z / 64c38ff9 / W）`
「残っているのは索引の副作用の修正 PR だけで、今作業中です。[NO-TEST-OK: 索引修正 PR は実装レーンで作業中で、
まだ完了報告ではない。終わり次第、索引のバイト数とテストを配置場所で実行して確認する]」。
検出器は `tools/permanent-fix-deferral-scan.mjs`（夜間 `handoff-audit-nightly`）と Stop 時の `tools/deferral-wait-gate.mjs`。
形式の先例は `tools/handoff-audit-findings-deferral-3423fc16.md`。

送信なし・権限変更なし・kim への DM なし。台帳は読み取りのみ。

## 結論（4点）

1. **原文の逐語再発は無い。** 当該ターンの記録 3 行（`stop-gate-runner` / `handoff-audit` / `handoff-audit-deferral` が同一時刻を記録したもの）だけで、以後 0。
2. **同型 W は同セッションの 16 秒後に 1 件**（2026-10-25T01:11:30.061Z、「終わると自動で通知が来るので、そのときに…確認して報告します」）。Stop 判定は `pass` だったが、現在のゲートでは block される。以後の再発は `--since` 走査で 0。
3. **先送りされた索引修正 PR は完了している。** PR #1106（2026-10-25T01:33:15Z merged / `631b492`）。本文に「117 passed / 0 failed」「索引: 8000 bytes」を記載、CI（test / clean-install / test-posix）SUCCESS。
4. **原文は現在の生きたゲートで block される**（repo と配備先 `~/.claude/nightly-repo` の両方で実測）。今回その原文と 01:11:30 の言い換えを回帰テストの陽性に固定した。

## 1. C1 逐語再発（3 台帳 + 補助 1 台帳）

| 台帳 | 総行数 | セッション 64c38ff9 | 原文一致（`今作業中です` + `NO-TEST-OK`） | 時刻 |
|---|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 1457 | 9 | 1 | 2026-10-25T01:11:14.426Z（当該ターン） |
| `handoff-audit-ledger.jsonl` | 1981 | 10 | 1 | 2026-10-25T01:11:14.307Z（当該ターン） |
| `handoff-audit-nightly-ledger.jsonl` | 109 | 0 | 0 | — |
| `handoff-audit-deferral-ledger.jsonl`（補助） | 50 | 2 | 1 | 2026-10-25T01:11:14.426Z（当該ターン） |

当該ターン以後の原文一致は 0。

## 2. C2 同型 W の走査

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-25T01:11:14Z`（2026-10-26 実行）:

| 台帳 | total | hits | 内訳 |
|---|---|---|---|
| stop-gate-runner | 1457 | 2 | W:2（01:11:14.426Z block / 01:11:30.061Z pass。いずれも 64c38ff9） |
| handoff-audit | 1981 | 0 | — |
| handoff-audit-nightly | 109 | 0 | — |

total>0 で観測は有効。2 件とも同一セッションの当該ターン付近で、以後の新規発生は 0。

## 3. C3 先送りの末路

- 当該ターン（01:11:14Z）の 4 分後 01:15:06Z に PR #1106 が作られ、01:33:15Z にマージ（`631b492`）。変更は `ONBOARDING.md` / `tools/onboarding-sync.mjs` / `tools/setup-manifest.json` / `tools/discord-dm.test.mjs`。
- 先送り文が約束した「索引のバイト数とテスト」は PR 本文に実測値（8000 bytes / 117 passed, 0 failed）で記載。
- 同セッションの後続 Stop 行（01:33:59 / 01:34:08 / 01:37:02）の 3 行はいずれも「終わりました」の完了報告で、現行ゲートで pass。台帳の excerpt は 200 字で切れているため、報告本文で索引バイト数を述べたかどうかは**台帳からは確認できない**（PR 本文の記載が証跡）。

## 4. C4 生きたゲートの実測

`judge(<原文 excerpt>)` の結果（repo の `tools/deferral-wait-gate.mjs` / `~/.claude/nightly-repo/tools/deferral-wait-gate.mjs`）:

| 実行先 | 判定 |
|---|---|
| repo | `block` / `DEFERRAL-WAIT` |
| nightly-repo | `block` / `DEFERRAL-WAIT` |

同セッションの全 9 行を repo のゲートへ通すと、00:53〜01:11:30 の 6 行は block、完了報告の 3 行（01:33:59 以降）は pass。
当時の実 Stop 判定は `blockedBy: [side-effect-left-gate]` で止まっていた（DEFERRAL-WAIT ではない）が、現在は DEFERRAL-WAIT でも止まる。

## 直したもの / 直さなかったもの / 未確認

- 直した: `tools/deferral-wait-gate.test.mjs` に原文と 01:11:30 の言い換えの陽性 2 件を追加（ゲート本体は変更なし。原文が既に block のため基準も弱めていない）。
- 直さなかった: ゲート本体・夜間検出器（再発 0・原文 block のため修正不要）。
- 未確認: 後続ターンの報告本文での索引バイト数の言及（台帳 excerpt が 200 字で切れる）。PR #1106 本文を証跡とした。
- 契約記載の `node --test tools/` は Node 24 / Windows でディレクトリをモジュールとして解決して失敗する（`Cannot find module ...\tools`）。CI は `node --test`（自動探索）と `tools/*.test.mjs`。検証は `node --test` で行った。
