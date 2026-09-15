# handoff-audit 検証報告: llm-ask.mjs（コマンド実行の委譲）

- 対象 TODO: `[handoff-audit:0d7217062cfd648d]`（元記録: session `5ef25c9b` / 2026-09-15 の block 判定で learned に「コマンド実行の委譲 => llm-ask.mjs」）
- 実施: 2026-09-16 03:2x JST（Windows / nishi@ のPC、auto-session）
- 結論: **llm-ask.mjs は既存権限で承認プロンプト無しに実行でき、テキスト生成の委譲経路として機能する。ただし「コマンド実行」自体は委譲できない**（実行主体は Claude の Bash/Write のまま）。

## 1. route 名の正確性（コードで確認）

`tools/llm-ask.mjs` は 99 行・import は `fs` / `os` / `path` / `env-kv.mjs` / `llm-fallback.mjs` のみ。
プロバイダの `chat/completions` に POST し、`choices[0].message.content` を stdout に出すだけ。`exec`/`spawn`/`child_process` を持たない。

→ 「コマンド実行の委譲」という表現は不正確。委譲できるのは **コマンド文字列・コード・回答の生成**まで。
   permission で拒否された操作を llm-ask が代行することもない（分類器はプロバイダ側ではなく Claude 側の関門なので、迂回経路にはならない）。

## 2. プロバイダ実測（2026-09-16 03:22 JST / `--no-fallback` / max 4000）

| provider | key | 結果 | 遅延 | 備考 |
|---|---|---|---|---|
| groq | set | ok | 0.8〜0.9s | 無料枠。429 が多く cooldown に載りやすい |
| openrouter | set | ok | 2.8〜2.9s | fallback の受け皿として実働 |
| deepseek | set | ok | 1.1〜1.2s | 最速・最安 |
| gemini | set | ok | 2.1〜2.3s | |
| grok | set | ok | 2.6s | |
| glm | **missing** | skipped | — | Coding Plan キー未設置 |
| cerebras | **missing** | skipped | — | 定額枠キー未設置 |
| genspark | **missing** | skipped | — | 前払いクレジットキー未設置 |
| kimi | set | **fail** | 3.8s | `exceeded_current_quota_error` / "suspended due to insufficient balance" |
| mistral | set | **fail** | 0.8s | HTTP403 `tier_not_allowed`（`mistral-large-latest` が契約外） |

- `FALLBACK_CHAIN`（llm-fallback.mjs）は groq → glm → cerebras → genspark → openrouter → deepseek → gemini → grok → kimi の順だが、**このPCでは 2〜4 番目が丸ごと空**で、実質 groq → openrouter → deepseek → gemini → grok の5経路。
- **kimi は残高不足で停止中**。中量級生成レーンとして推奨されている経路が現状死んでいる。
- mistral は key はあるが `mistral-large-latest` が契約 tier 外。連鎖には入っていないので実害は `--provider mistral` を明示した時だけ。

## 3. フォールバック実測

`--provider mistral`（403）から開始 → `[failover] mistral:mistral-large-latest HTTP403 → openrouter:openai/gpt-oss-120b` に自動切替し、exit 0 で回答を返した。連鎖は機能している。

## 4. `--max` の罠（検証条件のアーティファクト）

`--max 32` で groq / openrouter を叩くと `usage out=32tok` かつ content 空 = `(出力なし)`。
gpt-oss-120b が reasoning で枠を使い切るため。**既定 4000 では正しく "4" が返る**（再測で確認）。
`(出力なし)` は失敗と区別がつかないので、検証時に切り分けが要る。

## 5. 既存の消費者（このPCで稼働中）

`tools/handoff-audit-gate.mjs` の `askCli` が `execFile(node, [llm-ask.mjs, --provider, ...])` で起動。
2026-09-16 03:00 の nightly は 4 件を監査し block 判定を返している（`~/.claude/handoff-audit-nightly-ledger.jsonl`）= サブプロセス起動でも動作。

## 6. cooldown の観測

`~/.claude/provider-cooldown.json` に groq が `daily_limit` で約6時間の cooldown を記録していたが、
その最中に `--no-fallback` で直接叩くと 200 が返った。生きた経路を cooldown が塞いでいる（fallback があるので実害は小さい）。

## 7. 再現コマンド

```
node "C:/Users/user/orgiast-claude-rules/tools/llm-ask.mjs" --provider <name> --print-key-status
node "C:/Users/user/orgiast-claude-rules/tools/llm-ask.mjs" --provider <name> --no-fallback --max 4000 "プロンプト"
```
