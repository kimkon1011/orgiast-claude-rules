# handoff-audit 恒久修正: 先送り検出器を夜間監査に配線する（2026-09-29）

対象: `[handoff-audit:8e5bf9c4366126ee]`（「恒久修正を設計のみで次セッションへ送る」型）
関連: `docs/handoff-audit-2026-09-26-deferral-scan-sensitivity.md`（検出器の感度を 0/1 → 1/1 に直した PR #575）
読み取り専用の検証＋ツール改修。送信なし・価格変更なし・kim への DM なし。

## 1. 再発の実測（2026-09-29）

```
node tools/permanent-fix-deferral-scan.mjs --since 2026-09-25T18:05:00Z
stop-gate-runner-ledger.jsonl: hits=0 / 423
handoff-audit-ledger.jsonl: hits=0 / 282
handoff-audit-nightly-ledger.jsonl: hits=0 / 89
P1:0 P2:0 P3:0 P4:0 W:0（3台帳すべて）
```

この 0 は**盲点による 0 ではない**。唯一の既知真陽性（`2026-09-25T18:02:29.322Z` / session `3c012482`）に対する
感度は PR #575 で **1/1** に修正済みで、同じ検出器が同じ窓で真陽性を拾える状態にある。
すなわち 09-26 以降この型の再発は実測で 0 件。

## 2. 未配線だったこと（本 PR の動機）

`tools/permanent-fix-deferral-scan.mjs` はどこからも呼ばれていなかった
（`tools/nightly-batch.ps1` / `tools/setup-manifest.json` / `tools/register-hooks.mjs` のいずれからも未参照）。
前 doc §5 が「手で叩く計器」と書いていた状態のままで、**手で叩かない限り再発に気づけない**。
これは監査対象の先送り型と同型の先送り（計器を作って配線しない）だった。

さらに `handoff-audit-nightly.mjs` の `enqueueTodos` は id と route で重複排除するため、
同じ route のまま再発しても既存 TODO に吸収されて**行が増えず黙る**構造だった。

## 3. 恒久修正（本 PR）

- `tools/permanent-fix-deferral-scan.mjs`: `scan({ home, since, until })` に `until`（上限）を追加。
  窓は `since <= ts < until`。`--until` も CLI に追加（不正 ISO は既存と同じ exit 2 + `Usage:`）。
- `tools/handoff-audit-nightly.mjs`: `runNightly` が毎晩、前日0時〜当日0時の窓で検出器を回す。
  - 窓の実測行を `~/.claude/handoff-audit-deferral-ledger.jsonl` に**hits 0 でも必ず**書く（「0 は測った 0」）。
  - 未記録の検出だけを `hit` として追記し、`fresh > 0` のときだけ next-session.md に TODO を積む。
  - 重複排除は `deferralObservation(row) = hash([ts, sessionId, pattern, match])` で行う。
- TODO の pattern には**原文（80文字まで）とセッションID**が入り、route には実例の ts/sessionId が入るため、
  `enqueueTodos` の id・route 重複排除に吸収されず**毎回別の行として積まれる**。
- 検出器自体の失敗は `deferral.error` に残し、夜間監査本体は落とさない（既存の fail-open 方針に合わせる）。

## 4. 検証

- `tools/permanent-fix-deferral-scan.test.mjs`: `until` の境界（`ts === until` は含めない）と CLI `--until`。
- `tools/handoff-audit-nightly.test.mjs`: TODO 起票・再実行での非増加・hits:0 の窓行・pattern の80文字上限。
- `tools/setup-manifest.json` に `tool:permanent-fix-deferral-scan`（file-nonempty / optional）を追加し、
  配布先に検出器の実体があることを setup の収束で検査する。
