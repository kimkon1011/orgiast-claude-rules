# Gemini 費用計測 実装報告

指定の2単体テストは17件成功。作業ツリーの関連テスト14ファイルは189件成功。追加の codex-do 回帰テスト101件も成功。既存の未コミット変更を除いた独立コピーでも関連テスト12ファイル152件成功。新規単体テストのfs・DMはモック、CLI統合テストのHTTPは全件スタブ、ファイルは一時ディレクトリに隔離した。実台帳の変更・本物のDM送信・pushは行っていない。

## 記録を挿入した場所と経路監査

- `tools/llm-ask.mjs`: `onAttempt` で応答を読み、`appendAttempt` のGemini分岐から `recordGeminiUsage`。
- `tools/web-search.mjs`: `requestGeminiSearch` の `response.json()` 直後、空本文判定より前。
- `tools/line-digest.mjs`: `createLlmClient` の `onAttempt`。このクライアントを使うDiscord等の処理もここで記録。
- `tools/batch-run.mjs`: 通常APIの `onAttempt → usageRecord` と、Batch完了後の個々の `row.response`。料金はBatch倍率を使用。
- `tools/eval-harness.mjs`: `call` の応答JSON取得直後。評価対象とjudgeの両方に適用。
- `tools/codex-do.mjs`: Gemini CLIの各 `execute` 完了直後。メタデータがないので `in:null,out:null,usd:null,estimated:true`。
- `tools/gemini-mcp-usage-hook.mjs`: Claudeの `mcp__gemini-cli__ask-gemini` / `geminiChat` / `googleSearch` の実行後。構造化usageがなければ未計測行。
- `tools/cost-work-loop.mjs`: Gemini APIは呼ばず台帳を集計するコード。架空の呼び出し行を作らず予算status読込へ変更。
- `tools/tool-adoption-check.mjs`: バージョン・認証・登録の診断のみでAPI応答はない。架空の行は作らず、実際のMCP応答は上記フックで記録。
- `pricing-brief` / `ai-news-triage` は `web-search`、`cost-weekly-improve` は `llm-ask`、`discord-task-digest` は `line-digest` の共通クライアント経由。呼び出し元で重複記録しない。

## 料金と予算

`~/.claude/gemini-pricing.json` を優先し、存在しない場合のみ `config/gemini-pricing.default.json` を使う。壊れた設定、不明モデル、有効期限切れは `usd:null, pricing:"unknown"`。既定は2026-09-14に [Google公式料金](https://ai.google.dev/gemini-api/docs/pricing) で確認できた3.6/3.7/3.8 Flashの有料text API料金で、2026-12-31まで有効。`pricing-brief.mjs` は検索結果の文章を生成するもので、再利用可能な単価テーブルを持たない。

`usageMetadata.promptTokenCount` / `candidatesTokenCount` を使用し、native APIでは課金対象の `thoughtsTokenCount` も出力に加算。OpenAI互換APIでは実測の `usage.prompt_tokens` / `completion_tokens` を使う。cached tokenが返る場合は対応単価を適用する。

検索は共有無料枠の残量をローカル台帳から確定できないため、既定の `searchUsdPerCall` はnull。検索を含む呼び出し全体のusdをnullにして「既知」のふりをしない。独自料金を設定するときの例（数値はテスト用）:

```json
{"models":{"your-model":{"inputUsdPerMillion":1,"outputUsdPerMillion":2,"cachedInputUsdPerMillion":0.1,"batchMultiplier":0.5,"searchUsdPerCall":null}}}
```

予算設定例:

```json
{"budgetJpy":50000,"usdPerJpy":150}
```

`usdPerJpy` は指示で指定されたキー名を受け付けるが、単位は既存コードの `usdJpy` と同じ **1 USD あたりの円**。未指定時は `ORGIAST_USDJPY` → `tools/budget-fixed.json` の `usdJpy` →150。月予算の既定は50,000円。

60%未満ok、60〜85%（85%を含む）warn、85%超critical。未計測が20%超、台帳なし・空・不正行ありはunknown。未計測がある金額・月末ペースは計測できた分だけ。warn/critical/unknownは既存 `notifyKim` を使い、既存のユーザーID解決に従いDMする。webhook fallbackは使わない。dry-runは保存・DM・routing変更を一切行わない。

critical（unknownでも既知分が85%超の場合を含む）は既存 `routing-overrides.json` の `demote.gemini` に月末までの期限をマージする。他キー・他providerを保持し、壊れたJSONを上書きしない。`llm-fallback` がGemini明示指定でもOpenRouterを先に試す。降格なので、OpenRouter等が使えなければ最終候補のGeminiまで進み得る。

## 既存PCへの展開

Windowsは既存 `fleet-poller.ps1`、Macは既存 `fleet-poller.mjs` の日次実行に接続。新しい単独タスクの未登録問題を作らない。新規インストールの共通 `register-hooks.mjs` と、既存PCの `onboarding-sync → register-hooks --hooks-only` の双方でMCPフックを追加する。setup-manifestでも欠落を検出。料金JSONはWindowsインストーラと既存PCのZIP同期の双方で配布する。

この作業では配布・pushをしていないため、他PC・既に起動済みのClaudeセッションに適用済みとは扱わない。同期とフックを読む次回セッションが必要。

## 残る未計測

- 過去の `usd` 欠落行は金額不明のまま。過去のMCPなど、台帳に存在しない呼び出しは復元できず、件数にも含まれない。
- CLI出力のみのMCP応答、`codex-do` のGemini CLIは未計測として記録。MCP/CLI内部の複数API要求・再試行数は取得できず、記録件数は上位ツール呼び出し数。
- 検索の課金額はプロジェクト共通無料枠の消費が不明なので既定では未計測。
- 未知モデル、期限切れ・不正な料金設定、usageのない応答も未計測。
- 本フックを読み込まないクライアント、ターミナルで直接実行する `gemini -p`、他のプログラム・他PC・他プロジェクトの課金は自動捕捉しない。
- 取得済みusage×設定単価の台帳であり、Google請求書との照合ではない。通信中断・JSON応答取得前の失敗・完了を取得できなかったBatchなどは確定できない。月上限の残量が十分あるとは判断しない。

## 実台帳 dry-run

`node tools/gemini-budget-guard.mjs --dry-run` の出力。`spentUsd:0` は実費ゼロを意味せず、当月101行すべてにusdがないため計測済み合計がないことを示す。

```json
{
  "month": "2026-09",
  "spentUsd": 0,
  "spentJpy": 0,
  "budgetJpy": 50000,
  "pct": 0,
  "unmeasuredCalls": 101,
  "paceEomJpy": 0,
  "level": "unknown",
  "totalCalls": 101,
  "ledgerAvailable": true,
  "invalidRows": 0,
  "checkedAt": "2026-09-14T07:28:13.645Z"
}
```

## 変更ファイル一覧

- `config/gemini-pricing.default.json` — 公式料金の出典URL・確認日を先頭の _comment に保存（JSONの構文を維持）。モデル別料金と有効期限。
- `tools/batch-run.mjs` — 通常API試行とネイティブBatch個別応答を記録し、成功後の二重記録を防止。
- `tools/budget-status.mjs` — Gemini未計測件数を全体予算表示にも表示。
- `tools/codex-do.mjs` — Gemini CLI 各試行を未計測として記録し、最終fallback概算行の重複を抑止。
- `tools/cost-monthly-report.mjs` — 台帳USDと未計測件数を使用。前月の境界をJSTに合わせる。
- `tools/cost-monthly-report.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/cost-work-loop.mjs` — cost-directive を予算statusから生成。未計測・古い状態を明示し、無料枠残量の推測を撤去。
- `tools/cost-work-loop.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/eval-harness.mjs` — 評価対象・judge共通のAPI応答直後に記録。
- `tools/eval-harness.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/fleet-poller-specs.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/fleet-poller.mjs` — Macの既存日次経路から予算ガードを実行。dry指定は伝播。
- `tools/fleet-poller.ps1` — Windowsの実際の日次Task Scheduler経路から予算ガードを実行。Dry指定は伝播。
- `tools/gemini-budget-guard.mjs` — JST当月集計、状態保存、既存 notifyKim によるDM、既存 demote スキーマで降格。
- `tools/gemini-budget-guard.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/gemini-instrumentation.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/gemini-mcp-usage-hook.mjs` — MCP成功・失敗イベントの応答を記録。本文を台帳に保存しない。
- `tools/gemini-test-fs.mjs` — 新規単体テスト用のメモリ上の filesystem モック。
- `tools/gemini-usage-ledger.mjs` — 共通 append、実トークン正規化、料金ファイル読込、不明金額 null。
- `tools/gemini-usage-ledger.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/install-orgiast.ps1` — 新規・修復インストールのZIP配布対象に config/ を追加。
- `tools/line-digest.mjs` — 共通LLMクライアントのGemini試行応答を記録。
- `tools/llm-ask.mjs` — Gemini試行の実usageを共通台帳へ渡し、旧ゼロ補完の行を置換。
- `tools/llm-fallback.mjs` — 明示指定Geminiもdemoteを適用してOpenRouterを先頭にする。日次Gemini金額もusdを使用。
- `tools/llm-fallback.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/onboarding-sync.mjs` — 既存PCへのZIP配布対象に config/ を追加。
- `tools/onboarding-sync.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/register-hooks.mjs` — PostToolUse / PostToolUseFailure のMCP記録フックを追加登録。
- `tools/register-hooks.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `tools/setup-manifest.json` — MCP記録フックの未登録を検出して既存の登録器で修復。
- `tools/tool-adoption-check.mjs` — Gemini応答を取得しない診断コードであることを明記。「無料枠」の案内を従量表記へ修正。
- `tools/web-search.mjs` — 応答本文の検証より前に使用量を記録。空応答からのfallbackでも費用を落とさない。
- `tools/web-search.test.mjs` — 回帰・境界値・呼び出し経路のテストを追加／更新。
- `docs/gemini-cost-instrumentation.md` — この実装・検証・未計測経路の報告。

## Git成果物

元の作業ツリーには今回の変更を適用しているが、環境の権限設定で `.git` は読み取り専用のためブランチ作成・コミット不可。既存の未コミット変更を除いた独立コピー `/tmp/gemini-cost-commit` で `feat/gemini-cost-instrumentation` ブランチを作成し、今回の変更だけをコミットする。元リポジトリのブランチ・indexは変更しない。Git bundle と patch は `gemini-cost-delivery/` に保存する。pushはしない。
