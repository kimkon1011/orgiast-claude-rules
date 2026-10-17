# handoff-audit 再発検証: `f94561fe11a0dd0d`

検証日: 2026-10-17（Asia/Tokyo）  
対象: `2026-10-14T00:23:03.898Z` / session `38a89932-d8cc-4e0f-86de-0f9ae1181f85` / pattern P4

## 結論

対象検出以後、同型の先送りは再発していない。

元の P4 は恒久修正の許可を求めた文ではなく、文中の「ゲート解除可否」という実現可能性の名詞を旧検出器が拾った誤検出だった。現行検出器は複合語の裸の「可否」を除外し、疑問節つきの許可要求だけを P4 として検出する。この修正は commit `4a420e1`（PR #780）に含まれる。

## 原文の直接確認

- `~/.claude/handoff-audit-ledger.jsonl` の session `38a89932-d8cc-4e0f-86de-0f9ae1181f85` は `verdict: pass`、`violations: []`。
- `~/.claude/stop-gate-runner-ledger.jsonl` の同 session で P4 が見た原文は「実装ではなく、ゲート解除可否の実測と手渡し検証が本体」。許可依頼ではない。
- `~/.claude/handoff-audit-deferral-ledger.jsonl` の hit は `2026-10-14T00:23:03.898Z` のこの1件。

## 修正と対照の直接検証

実行:

```text
node --test tools/permanent-fix-deferral-scan.test.mjs
```

結果: 24 tests / 24 pass / 0 fail。次の両方を含む。

- 「実現可能性の名詞『〜可否』はP4と誤検出しない」: pass
- 「疑問節つきの『可否』は引き続きP4で検出する」: pass

再発走査:

```text
node tools/permanent-fix-deferral-scan.mjs --since 2026-10-14T00:23:03.899Z --json
```

実台帳での結果:

| 台帳 | P1 | P2 | P3 | P4 | W | 合計 |
|---|---:|---:|---:|---:|---:|---:|
| `stop-gate-runner-ledger.jsonl` | 0 | 0 | 0 | 0 | 0 | 0 |
| `handoff-audit-ledger.jsonl` | 0 | 0 | 0 | 0 | 0 | 0 |
| `handoff-audit-nightly-ledger.jsonl` | 0 | 0 | 0 | 0 | 0 | 0 |

したがって、元検出より後に記録された台帳範囲では、P4を含む同型の再発は0件。exit codeだけでなく、自己テストの陽性・陰性対照と実台帳の各パターン別件数を読み戻して確認した。
