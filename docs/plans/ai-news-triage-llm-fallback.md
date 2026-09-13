# ai-news-triage の LLM 判定失敗を「特定できる」ようにしてから鎖を直す

> この md は `skills/requirements-freeze/SKILL.md` の Phase 1〜3 を通して出力された実装手順書（同 skill の初回適用例）。
> **Phase 4（実装）には入っていない。** 実装前に承認が必要。

## 1. 目的 / 成功条件（客観的に判定できる形で）

**目的**: 夜間バッチ `ai-news-triage` の LLM 判定失敗（`stage="llm"` / `判定JSONを復旧できません`）を、
**まず「どのプロバイダが返しているか」をデータで特定できる状態にし**、そのうえで犯人を鎖から外すか
`--provider` を固定して、失敗を 0 件にする。

**成功条件（第三者に見て真偽が判定できる1文）**:
夜間バッチを3夜連続で回したあと、`~/.claude/ai-news-triage-failures.jsonl` への
`stage:"llm"` の**新規追記が 0 件**であり、かつ各夜の triage が既定の 900 秒以内に完走している。

## 2. スコープ外（今回やらないこと）

- 検索レーン（`tools/web-search.mjs`）の枯渇修復 — gemini 前払い切れ / groq 無料枠 TPD 上限。**別TODOとして既に切り分け済み**（`2026-09-12-23.summary.md`）
- 提案の採否判定ロジック（`parseVerdict` の判定基準）の変更
- 新しい LLM プロバイダの追加

## 3. 前提・確定事項（Phase 1 の結果）

⚠️ **この手順書は無人セッションが Phase 1 を「既定値（推奨）」で通したもの。**
kim の回答で変わりうる行には ■要確認 を付けた。無人セッションでは一問一答ができないため、
既定値を採用した事実をここに明示する（黙って既定にしない）。

| # | 項目 | 確定事項 | 出所 |
|---|---|---|---|
| 1 | 目的 | 上記1 | 既定（`~/.claude/next-session.md` の残TODO） |
| 2 | 利用者 | 無人ジョブ（夜間 03:00 の schedule） | 既定 |
| 3 | 入力 | `~/.claude/ai-news-proposals.jsonl` ＋ `webSearch(provider:'auto')` | 実測 `tools/ai-news-triage.mjs:134` |
| 4 | 出力 | 同 jsonl への verdict 書き戻し ＋ `~/.claude/ai-news-triage-failures.jsonl` | 実測 `:163` |
| 5 | 実行環境 | このPC（Windows）/ GitHub Actions schedule / 認証あり | 実測 |
| 6 | 成功条件 | 上記1（3夜連続で llm 失敗 0 件） | 既定 |
| 7 | 非目標 | 上記2 | 既定 |
| ■要確認 | 「犯人を鎖から外す」まで許すか、`--provider` 固定で止めるか | 既定=外してよい（`routing-overrides.json` の demote で戻せるため） | **未回答** |

### 実測した失敗の形（証拠・すべてこのセッションで取得）

- `~/.claude/ai-news-triage-failures.jsonl` は **4行**（最終 2026-09-13 04:36）。
  **4件すべて `stage:"llm"` / `message:"判定JSONを復旧できません"`**。`stage:"search"` は 0 件。
- 同レコードのキーは `{id, stage, error}` のみで、**`provider` を持たない**
  （集計すると `provider: {"?":4}`）。**これが「犯人を特定できない」直接の原因。**
- 鎖の実体: `tools/ai-news-triage.mjs:152` が
  `llm({ provider: cli.provider, ..., responseFormat: { type: 'json_object' } })` を呼び、
  既定は `cli.provider = 'groq'`（`:18`）。`llm` は `createLlmClient`（`tools/llm-ask.mjs`）で、
  内部は `tools/llm-fallback.mjs` の `callWithFallback`。
- **プロバイダ名は成功時には取れている**: `:154` が `response.provider || cli.provider` を使っている。
  つまり**情報は存在するのに、失敗時だけ捨てている**（例外が `parseVerdict` から飛ぶため）。
- 失敗時刻（09-13 04:36 JST = 2026-09-12T19:36Z）周辺の実測鎖（`~/.claude/executor-usage.jsonl`、窓内 205 件）:
  - `groq | openai/gpt-oss-120b | status=http_429 | failover=false` **12件**（枯渇して落ちている）
  - `glm | glm-5.3 | status=cooldown` 5件
  - `openrouter | openai/gpt-oss-120b | status=ok | failover=true` **75件**（= 実際に答えているのは主にこれ）
  - `genspark | gpt-5.6-luna | status=ok | failover=true` **25件**
  - → **groq が 429 で落ち、openrouter/genspark に落ちた先が JSON を返さないことがある**、という構図までは実測で見えている。どの1社が返しているかは**未特定**（それがこの手順の第1ステップ）。

## 4. 採用案と却下案（Phase 2 の結果）

| 案 | 概要 | 工数感 | リスク | 拡張性 | 運用コスト | user の手作業回数 |
|---|---|---|---|---|---|---|
| **A** | 失敗レコードに「回答した provider / model / attempt」を記録し、**1夜回して犯人をデータで確定**させてから、その1社だけ鎖から外す | 小（例外に文脈を載せる） | 起きたら: 記録追加だけなので既存の判定は一切変わらない。最悪でも失敗の種類が増えるだけ | 高い（以後どのプロバイダが壊れても同じ記録で特定できる） | 追加コストなし | **0回** |
| B | `--provider deepseek` を固定し、鎖を1本にする | 極小（1行） | 起きたら: **未特定のまま犯人を回避する**だけ。deepseek 側が同じ挙動をした瞬間に全滅し、しかも今回と同じ「特定できない」状態に戻る | 低い（プロバイダを変えるたび設定変更） | 従量課金が増える可能性 | 0回 |
| C | 自動化しない（毎朝 kim がログを見る） | 0 | 起きたら: 見忘れた夜は失敗が静かに積み上がる | なし | — | **毎日1回・年365回** |

**推奨: 案A。**
理由は3行:
1. いま足りないのは「直すこと」ではなく「**どのプロバイダが返しているか分からないこと**」。B はそれを回避するだけで、次に別のプロバイダが壊れたら同じ袋小路に戻る。
2. A の変更は失敗時の記録のみで、**判定結果を1件も変えない**ため退行リスクが実質ゼロ。
3. 追加コスト0・user の手作業0回で、以後の同種障害を恒久的に短縮できる。

却下理由:
- **B**: 未特定のまま回避するので、同じ症状が再発したときの診断能力が上がらない（今回の TODO の目的そのものを満たさない）。
- **C**: user の手作業が年365回発生する。この会社の最上位ルール（user の手作業は最上位コスト）に反する。

## 5. 実装手順（各ステップに完了条件）

1. `tools/ai-news-triage.mjs` の `parseVerdict` 呼び出しを try/catch で包み、失敗時に
   `provider` / `model` / `attempt` / `failover` を失敗レコードへ載せる。
   `createLlmClient` が最後の試行のメタを返せるようにする（`llm-ask.mjs` の `rec` と同じ項目）。
   - **完了条件**: 失敗レコードのキーが `{id, stage, error, provider, model, attempt}` になる。
2. `applyTriageResult` の保存経路（`:163` の jsonl 追記）にその項目が実際に書かれることを、
   失敗を人工的に起こしたテストで固定する。
   - **完了条件**: `node --test tools/ai-news-triage.test.mjs` に「失敗レコードに provider が入る」テストが1本増え、pass する。
3. `node tools/ai-news-triage.mjs --dry-run --limit 3` をこのPCで回し、`ai-news-proposals.jsonl` の pending から3件処理して、**正常系で provider が変わっていない**ことを確認する。
   - **完了条件**: 3件の verdict が更新され、`executor-usage.jsonl` の provider 構成が変更前と同じ。
4. PR を出して CI green → squash merge。
   - **完了条件**: CI `test` / `test-posix` が pass、`gh pr view --json mergeable` が `CLEAN`。
5. **1夜待つ**（このステップは次回の自動セッションで行う）。
   - **完了条件**: 翌朝 `ai-news-triage-failures.jsonl` の新規 `stage:"llm"` 行に `provider` が入っている。
6. 手順5で得た provider を犯人と確定し、`~/.claude/routing-overrides.json` の demote に追加する
   （または `--provider` を固定する）。
   - **完了条件**: 当該プロバイダが鎖から外れ、`--dry-run` 1件が成功する。
7. 3夜連続で `stage:"llm"` の新規追記が 0 件であることを確認する。
   - **完了条件**: セクション1の成功条件を満たす。

## 6. 検証方法（実行するコマンドと期待する出力）

```bash
# 手順3: 正常系が壊れていないこと
node tools/ai-news-triage.mjs --dry-run --limit 3
# 期待: exit 0 / 標準出力に "ok:検証3件 ... 判定失敗0件"

# 手順2: 失敗時の記録
node --test tools/ai-news-triage.test.mjs
# 期待: fail 0 / 追加した「失敗レコードに provider が入る」テストが pass

# 手順5: 翌朝の証拠（これが唯一の客観証拠）
node -e "const fs=require('fs');const p=process.env.USERPROFILE+'/.claude/ai-news-triage-failures.jsonl';const rows=fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);const win=rows.filter(r=>r.stage==='llm'&&r.t>='<実行日の朝>');console.log(win.length,JSON.stringify(win.map(r=>r.provider)))"
# 期待: 0件、または provider に実名（'groq' | 'openrouter' | 'genspark' 等）が入っている（'?' や undefined が1件も無い）

# 退行の確認（削除行を目で読む）
git diff origin/main -- tools/ai-news-triage.mjs | grep '^-' | grep -v '^---'
# 期待: 削除行が「記録項目の追加」に伴うものだけであること
```

## 7. ロールバック手順

- 手順1〜2: 追加した記録項目を消すだけで、判定ロジックには触れていないため影響は記録のみ。`git revert <squash-commit>` で戻る。
- 手順6: `~/.claude/routing-overrides.json` の demote から当該プロバイダを外せば元の鎖に戻る（即時・再デプロイ不要）。

## 8. 残TODO / 次回への引き継ぎ

- 手順5（1夜待ち）は**このセッションでは実行できない**。次回の自動セッションの先頭に
  「ai-news-triage の失敗レコードに provider が入ったか確認（`ai-news-triage-failures.jsonl`）」を1行で立てる。
- ■要確認（セクション3）: 「鎖から外す」まで許すか。既定は「外してよい」で進める。
- 関連: 検索レーンの枯渇（gemini 前払い / groq 無料枠）は別TODOのまま。**この手順は検索レーンを直さない。**
