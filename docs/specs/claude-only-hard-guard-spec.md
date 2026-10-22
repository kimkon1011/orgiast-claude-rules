# 指示書B: 「Claude だけで実装しない・従量課金で Claude Code を動かさない」を hook で破れなくする

## 背景（事故 2026-10-17）
- seisaku-team@orgiast.jp 名義の Console 組織（API 従量課金）で 7/10 から毎日 $10〜60、直近100通の領収書で $4,240 が流出していた。Claude Code を Team シート(定額)ではなく Console(従量)で動かす、または Claude だけで実装を挽く、という2つの経路を機械的に止める hook が無かった。
- 既存の委譲ガードは (a) `cost-enforce.json` の mode が `block` のときだけ deny、(b) `~/.claude/cost-enforce-override` ファイルがあれば無効、(c) Codex クールダウン中は自動で解除、(d) `pretooluse-lane-guard` は main model が Fable/Opus のときしか動かない（Sonnet セッションは素通り）。これらは全部「抜け道」で、kim の 2026-10-17 厳命「絶対に破れないようにする」に反する。

## 方針
1. **解除できるのは user のプロンプト中のマーカーだけ**（Claude 自身が作れるファイルやクールダウン判定では解除しない）。マーカーは UserPromptSubmit hook が検知してセッション限定・60分の許可ファイルに変換する。
2. **モデルを問わず適用**（Fable/Opus/Sonnet/Haiku 全部）。
3. **従量課金ログインの検知**: Console/API キーで動いている Claude Code は全ツールを deny。

## 変更

### 1. 新規 `tools/claude-impl-approval.mjs`（UserPromptSubmit）
- stdin の hook 入力（`prompt`, `session_id`）を読み、user プロンプトに `[CLAUDE-IMPL-OK]` または `[LANE-OK]` が含まれるとき `~/.claude/claude-impl-allow.json` に `{ sessionId, until: now+60min, marker }` を書く。「使うな」「禁止」等の否定文脈（`fable-session-guard.mjs` の既存の否定判定ロジックを参考に）では発行しない。
- `[API-BILLING-OK]` を含むとき `~/.claude/claude-billing-allow.json` に同形式で書く。
- 発行時は additionalContext で「許可を発行: <marker> まで <until>」と出す。
- `export function implApproved(home, sessionId, now)` / `export function billingApproved(home, sessionId, now)` を他 hook から読めるよう export（`tools/lib/claude-approval.mjs` に置いて両方から import してもよい）。
- `GATE_CONTRACT` を既存 hook と同じ形で export（`tools/selftest-guards.mjs` の要求を確認して合わせる）。

### 2. 新規 `tools/api-billing-guard.mjs`（SessionStart / UserPromptSubmit / PreToolUse 全ツール）
- `export function detectBillingMode({ home, env = process.env, claudeJson, credentials, settings })` → `{ mode: 'subscription'|'api'|'proxy'|'unknown', reason, extraUsage, account, org }`。判定順:
  1. `env.ANTHROPIC_BASE_URL` があり host が `api.anthropic.com` 以外 → `proxy`（cheap-code / glm-code の経路。許可）。
  2. `env.ANTHROPIC_API_KEY` または `env.ANTHROPIC_AUTH_TOKEN` がある → `api`。
  3. `~/.claude/settings.json` に `apiKeyHelper` がある → `api`。
  4. `~/.claude.json` の `oauthAccount.billingType === 'stripe_subscription'`、または `~/.claude/.credentials.json` の `claudeAiOauth.subscriptionType` が `team|pro|max|enterprise` → `subscription`。
  5. `oauthAccount` があり `billingType` が上記以外の非空文字列 → `api`（理由に billingType を入れる）。
  6. それ以外（読めない・空） → `unknown`（deny しない）。
  - `extraUsage = oauthAccount.hasExtraUsageEnabled === true`（Team の「上限超過後も従量で使う」設定）。
  - 実機の値（kim-PC）: oauthAccount keys = accountUuid,emailAddress,organizationUuid,hasExtraUsageEnabled,billingType,…,organizationName,…; billingType=`stripe_subscription`; credentials.claudeAiOauth.subscriptionType=`team`。これをテストのフィクスチャにする。秘密値（accessToken 等）は一切読まない・出さない。
- 振る舞い:
  - SessionStart / UserPromptSubmit: `api` なら additionalContext に `🔒 このPCの Claude Code は従量課金(Console/APIキー: <reason>)で動いています。§2.8.5 により全ツールを停止します。\`claude /login\` で Claude アカウント(Team シート)を選び直してください。kim が同じ指示で [API-BILLING-OK] と書いたときだけ60分許可。` を出し、`~/.claude/api-billing-detected.json` に `{ at, mode, reason, account }` を書く。さらに **1日1回** kim へ通知: `notify-kim.mjs` の `notifyKim` を試し、Discord token が無い PC では `node tools/fleet-mail.mjs --send --to kim-PC --kind note --body-file <tmp> --why "従量課金ログイン検知"` を `tools/lib/background-spawn.mjs` の `backgroundSpawnOptions()` で背景起動（`detached:true` 直書き禁止。CI の no-visible-console-window テストが落ちる）。通知状態は `~/.claude/api-billing-notified.json`（日付）。
  - `extraUsage === true` のとき（mode に関係なく）: additionalContext に `⚠️ このアカウントは上限超過後の従量課金(extra usage)が ON です。kim の方針(2026-09-08 OFF)と不一致。` を出し、同じく1日1回通知。deny はしない。
  - PreToolUse（matcher なし＝全ツール）: `api` かつ `billingApproved` でなければ `permissionDecision: 'deny'`、理由は上の 🔒 文。`proxy` / `subscription` / `unknown` は何もしない。
  - hook は例外で落ちない（try/catch、stdin 無しは exit 0）。stdin 読みは `tools/lib/hook-stdin.mjs` の `readStdinWithTimeout`。

### 3. `tools/pretooluse-lane-guard.mjs`
- `if (!/(?:fable|opus)/i.test(model)) return;` を削除し、全モデルに適用（`inspectTranscript` が失敗したら従来どおり return）。
- `cost-enforce-override` の判定を削除。例外は `state.laneOk`（cost-routing-gate が `[LANE-OK]` で立てる）または `implApproved(home, session_id)` のみ。
- 警告文の「または ~/.claude/cost-enforce-override」を「または user プロンプトに [CLAUDE-IMPL-OK]」に変更。

### 4. `tools/pretooluse-delegation-warn.mjs` / `tools/pretooluse-bash-delegation.mjs`
- `cost-enforce.json` の mode と `cost-enforce-override` と `codexHardBlockBypass()` の判定を削除。対象（delegation-warn: substantial な Write/MultiEdit/Edit>400字のアプリ実装コード、bash-delegation: 6000字超の書き込みを伴うインラインプログラム）は常に deny。`implApproved(home, session_id)` のときだけ通し、additionalContext で「user 承認 [CLAUDE-IMPL-OK] により許可（期限 …）」と出す。
- deny 理由（両方共通の末尾）: `Codex が上限中でも node tools/codex-do.mjs は deepseek/glm/gemini へ内蔵フォールバックする。全滅なら実装を止め、kim に費用見込みを提示し、kim がプロンプトに [CLAUDE-IMPL-OK] と書いたときだけ60分許可(§1.18、2026-10-17 kim 厳命)。`
- 除外（memory/.claude/docs/tools/test 等のパス、コード拡張子判定）は現状維持。

### 5. `tools/cost-work-loop.mjs` の `decideEnforcement`
- 戻り値は常に `{ mode: 'block', reason: '恒久ブロック(2026-10-17 kim 厳命: Claude 単独実装禁止)。<従来の委譲率メトリクス文>', decidedBy: 'policy' }`。`override` 引数は受け取っても無視し、`overrideGuidance` の文言を削除。
- `cost-enforce.json` の書き出し形は維持（他ツールが読む）。テストを更新。

### 6. `tools/model-agent-guard.mjs`
- 既存の Fable 判定に加え: `tool_input.prompt` が実装依頼（`cost-routing-gate.mjs` の `IMPLEMENT` 正規表現を export して再利用）で、`subagent_type` が `Explore|Plan|claude-code-guide|biz-reader|statusline-setup` 以外、かつ `implApproved` でないとき deny。理由: `実装サブエージェントは禁止(§1.17)。node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> へ。例外は user の [CLAUDE-IMPL-OK]`。
- `cost-routing-gate.mjs` から `IMPLEMENT` を `export const IMPLEMENT = ...` にする（既存の挙動は変えない）。

### 7. 登録と自己修復
- `tools/register-hooks.mjs`: 
  - SessionStart に `api-billing-guard.mjs`（timeout 5、同期）
  - UserPromptSubmit に `api-billing-guard.mjs`（timeout 5）と `claude-impl-approval.mjs`（timeout 5）
  - PreToolUse に `api-billing-guard.mjs`（matcher なし、timeout 5）
  - 既存の `add()` / `command()` ヘルパーの流儀に従う。
- `tools/hook-selfcheck.mjs` の `REQUIRED_HOOKS` に追加: `['SessionStart','api-billing-guard.mjs']`, `['UserPromptSubmit','api-billing-guard.mjs']`, `['PreToolUse','api-billing-guard.mjs']`, `['UserPromptSubmit','claude-impl-approval.mjs']`, `['PreToolUse','pretooluse-lane-guard.mjs']`, `['PreToolUse','pretooluse-delegation-warn.mjs']`, `['PreToolUse','pretooluse-bash-delegation.mjs']`。
- `tools/setup-manifest.json`: `settings:api-billing-guard`（file-contains）、`settings:claude-impl-approval`（file-contains）、`settings:lane-guard`（file-contains `pretooluse-lane-guard`）、`hook:api-billing-guard`（file-nonempty、paths は既存項目と同じ2候補）を required で追加。repair は既存項目と同じ。
- `tools/gate-remedies.md` に `## api-billing-guard` と `## claude-impl-approval` の節（1〜2行）を追加。

### 8. テスト
- 新規 `tools/api-billing-guard.test.mjs`（detectBillingMode の表: subscription / api(env) / api(apiKeyHelper) / api(billingType=prepaid) / proxy / unknown / extraUsage）、`tools/claude-impl-approval.test.mjs`（発行・否定文脈・期限切れ・別セッション）。
- 既存テスト更新: `pretooluse-lane-guard.test.mjs`、`pretooluse-delegation-warn.test.mjs`、`pretooluse-bash-delegation.test.mjs`、`cost-work-loop.test.mjs`、`model-agent-guard.test.mjs`、`hook-selfcheck` 関連、`register-hooks` 関連、`selftest-guards.mjs`（`writeCostEnforce` で warn を書いても deny になる前提に直す）。
- 実行: `node tools/selftest-guards.mjs` と `node --test tools/api-billing-guard.test.mjs tools/claude-impl-approval.test.mjs tools/pretooluse-lane-guard.test.mjs tools/pretooluse-delegation-warn.test.mjs tools/pretooluse-bash-delegation.test.mjs tools/cost-work-loop.test.mjs tools/model-agent-guard.test.mjs tools/hook-selfcheck.test.mjs tools/no-undistributed-imports.test.mjs`（存在するものだけ）。

## 守ること
- hook は stdin を `readStdinWithTimeout` で読み、例外では deny しない（fail-open）。deny は仕様で決めた条件のときだけ。
- 秘密値（トークン・キー）を読まない・出力しない。`.credentials.json` は `claudeAiOauth.subscriptionType` だけ参照。
- `detached: true` を直書きしない。背景起動は `tools/lib/background-spawn.mjs`。
- 新規 .mjs の import は `tools/` 配下のみ。BOM を書かない。Windows パス対応。
- push / commit はしない。完了報告は「変更ファイル一覧」と「テストの件数要約」だけ。ログ全文は貼らない。
