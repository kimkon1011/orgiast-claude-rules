# claude.ai コネクタ子プロセス実行経路と RemoteTrigger 利用手順（2026-10-15）

この PC（DESKTOP-63MQR3L）の自動セッションから claude.ai コネクタ（Google Drive / Docs / Sheets / Calendar / Gmail 等）および RemoteTrigger（claude.ai Routines API）を呼び出すための子プロセス起動方式とラッパ運用の記録。

## 結論

API キー系環境変数（`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`）を外した `claude` 子プロセスを起動することで、`~/.claude/.credentials.json` の claude.ai OAuth ログインが利用され、**claude.ai コネクタと RemoteTrigger が正常に動作する**。

これまで毎回手書きしていた `env -u ANTHROPIC_AUTH_TOKEN ...` のシェルワンライナーは不要となり、以下の2つのラッパ CLI に集約された:

| ツール | 役割 | 主なユースケース |
|---|---|---|
| `tools/claude-ai-run.mjs` | 子 claude プロセス共通起動ラッパ | Drive/Docs/Sheets/Gmail の直接参照・操作、コネクタ接続確認（`--check`） |
| `tools/remote-trigger.mjs` | RemoteTrigger 操作専用 CLI | ラハイナ週次/月次 Routine などの実行（`run`）、実行ログ回収（`get_run_log`） |

## なぜ認証競合が起きるのか

Claude Code は認証源に優先順位を持っている（**API キー > claude.ai OAuth ログイン**）。

この機体の自動セッションは定額レーン運用のために以下の環境変数が設定されて起動している:
- `ANTHROPIC_AUTH_TOKEN`: DeepSeek プロキシ用トークン
- `ANTHROPIC_BASE_URL`: `https://api.deepseek.com/anthropic`

この状態では Claude Code は API キー認証モードとなり、`claude mcp list` を実行すると以下の警告が出て **claude.ai コネクタが無効化される**:
`⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set`

認証系環境変数を一時的に除去（strip）した子プロセスで起動すると、Claude Code は既定の `~/.claude/.credentials.json`（claudeAiOauth, scopes に `user:mcp_servers` 等を含む）にフォールバックし、全コネクタがロードされる。

## 実測データ（出典を明記）

出典: `C:\Users\kimko\.claude\auto-session\runs\2026-10-14-3.summary.md` §0（実測日: 2026-10-14）

| 項目 | 実測結果 | 詳細 |
|---|---|---|
| `claude mcp list` | **✔ Connected** | Google Drive / Google Docs / Google Sheets / Google Calendar / Gmail / Canva / tldv / Claude Docs の全コネクタがロード成功 |
| RemoteTrigger: `list_runs` | **HTTP 200** | トリガー一覧および過去の実行履歴を正常取得 |
| RemoteTrigger: `run` | **HTTP 200** | トリガー `trig_017cwe1Kwy6BWxs3zoF8DLre`（ラハイナ週次 Routine）のキックに成功 |
| RemoteTrigger: `get_run_log` | **HTTP 200** | 実行ログのテキストを正常回収 |

## 使い方

### 1. `tools/claude-ai-run.mjs`

```bash
# 接続確認: claude.ai コネクタがロードされているか確認
node tools/claude-ai-run.mjs --check

# ドライラン: 子プロセスを起動せず、argv / プロンプト文字数 / 除去された環境変数キーを確認
node tools/claude-ai-run.mjs --dry-run "Drive の作業ファイルを一覧表示してください"

# 指示の実行（直接指定）
node tools/claude-ai-run.mjs "Google Drive の「ラハイナ」関連ドキュメントを検索してください"

# 指示ファイルから実行（タイムアウト 180秒指定）
node tools/claude-ai-run.mjs --prompt-file path/to/instruction.md --timeout 180
```

`--dry-run` の出力例:
```json
{
  "executable": "C:\\Users\\<USER>\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
  "argv": [
    "C:\\Users\\<USER>\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    "-p",
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "text"
  ],
  "promptVia": "stdin",
  "promptChars": 128,
  "strippedKeys": [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY"
  ],
  "connectorCredentialPresent": true
}
```

### 2. `tools/remote-trigger.mjs`

```bash
# トリガー一覧を取得
node tools/remote-trigger.mjs list_triggers

# トリガーを実行
node tools/remote-trigger.mjs run '{"trigger_id":"trig_017cwe1Kwy6BWxs3zoF8DLre"}'

# 実行ログを取得（run の id は session_id という名前で渡す。run_id ではない）
node tools/remote-trigger.mjs get_run_log '{"session_id":"cse_015uGLEshSvParaFYTYZdkdA"}'

# ドライラン
node tools/remote-trigger.mjs run '{"trigger_id":"trig_017cwe1Kwy6BWxs3zoF8DLre"}' --dry-run
```

### payload の形（2026-10-14 の実測ログで確認した引数）

引数名を間違えると「呼べたのに何も返らない」ではなく**エラーにも気づかず空振りする**ので、実測で確認できた形をそのまま使うこと。

| action | payload | 実測の出典 |
|---|---|---|
| `list_triggers` | `{}` | — |
| `run` | `{"trigger_id":"trig_017cwe1Kwy6BWxs3zoF8DLre"}` | `runs/2026-10-14-3.rt-run.md` |
| `list_runs` | `{"trigger_id":"trig_017cwe1Kwy6BWxs3zoF8DLre"}` | `runs/2026-10-14-3.rt-probe.md` |
| `get_run_log` | `{"session_id":"cse_015uGLEshSvParaFYTYZdkdA"}` | `runs/2026-10-14-3.rt-log.md` |

`get_run_log` の run 識別子は **`session_id`**（値は `cse_...`）。`run_id` という名前ではない。

## 確定している制約（限界）

- **RemoteTrigger API のスコープ**:
  利用可能なアクションは `list_triggers`, `get_trigger`, `create_trigger`, `update_trigger`, `list_runs`, `run`, `get_run_log`, `create_webhook_trigger` のみ。
- **環境（environment）の egress 許可ドメインは API 経由で変更不可**:
  外部通信を伴う Routine で接続拒否（接続先ドメイン未許可）が発生した場合、RemoteTrigger 経由ではドメインを追加できない。**claude.ai の Web UI（設定画面）でのみ変更可能**である（2026-10-14 確定）。

## 落とし穴とリカバリ

- **`-p`（print モード）は最終メッセージしか返さない**:
  `claude -p` は中間の思考過程や前置きを出さず、最後のレスポンスのみを stdout に返す。そのため、プロンプトの先頭に必ず以下の指示を自動注入している:
  `[headless:claude-ai-run] 回答は1つの最終メッセージに全文を出す。「前の回答のとおり」等の参照は禁止。`
- **応答テキストが消えた場合のリカバリ**:
  もし子プロセスの出力が途切れたり失われた場合は、子セッションの transcript ファイルから全文を回収可能:
  `~/.claude/projects/**/<session-id>.jsonl`

## 未確認（断定しない事項）

- claude.ai 側の OAuth トークンの失効周期やバックグラウンド更新挙動の詳細は未確認（失効した場合はブラウザまたは `claude login` での再認証が必要）。
- Canva / tldv コネクタの個別 API 挙動については本環境では未使用のため未確認。

## 検証方法

```bash
# コネクタ接続の確認
node tools/claude-ai-run.mjs --check

# 単体テストの実行
node --test tools/claude-ai-run.test.mjs tools/remote-trigger.test.mjs
```

### 2026-10-15 のラッパ実機検証（実データ）

`node tools/claude-ai-run.mjs --check --timeout 150` を実行し、**exit 0** かつ以下を確認した
（＝ラッパ経由の子プロセスで実際にコネクタがロードされることの実測。手書きの `env -u ...` と等価）:

| コネクタ | 実測 |
|---|---|
| claude.ai Google Drive | ✔ Connected |
| claude.ai Google Docs | ✔ Connected |
| claude.ai Google Sheets | ✔ Connected |
| claude.ai Google Calendar | ✔ Connected |
| claude.ai Gmail | ✔ Connected |
| claude.ai Canva / tldv | ✔ Connected |

`node --test tools/claude-ai-run.test.mjs tools/remote-trigger.test.mjs` → **16/16 pass**（2026-10-15）。
