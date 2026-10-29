# gemini-cli `run_shell_command` policy 拒否の仕様

調査日: 2026-10-29  
対象: `@google/gemini-cli`、codex-do の gemini-cli フォールバック  
調査方法: リポジトリ、既存ログ、インストール済みパッケージ、公式ドキュメントの静的解析のみ。Gemini CLI にコマンドを実行させる再現試験は行っていない。

## 結論

`--approval-mode yolo` は `run_shell_command` を含む全ツール呼び出しの確認を自動承認する。したがって「Gemini CLI は YOLO でも shell 権限を原理的に持たない」は誤りである。

ただし YOLO は、あらゆるセキュリティ判断を無効化するフラグではない。ポリシーエンジンは一致する規則の優先順位で `allow` / `deny` / `ask_user` を決め、ユーザーまたは管理者の deny、`tools.exclude`、`tools.confirmationRequired`、許可パスや ignore pattern の検査などが別に存在する。ワークスペース trust も別の機構である。

現在の codex-do の引数 `--approval-mode yolo --skip-trust` と環境変数 `GEMINI_CLI_TRUST_WORKSPACE=true` は、公式仕様上、通常の headless shell 実行に必要な approval と workspace trust を満たしている。一般に不足している必須フラグは確認できなかった。観測された無理由の `Tool execution denied by policy.` が、どの規則に一致したものかは既存ログに rule/source が記録されておらず、未確定である。

一方、拒否はタスク固有の絶対的な状態ではない。既存ログには policy denial を含みながら出力を返した gemini-cli run もある。shell 不要の調査は専用の read/search ツールへ誘導できるが、テスト、ビルド、git など shell が成果条件のタスクでは代替にならないため、gemini-cli をスキップして別 backend へ送るべきである。

## 確定できた仕様

### 1. YOLO が承認する範囲

公式 CLI 設定リファレンスは `--approval-mode yolo` を「Automatically approve all tool calls」と定義している。ポリシーエンジンの公式説明でも、YOLO は全ツールを自動承認するモードであり、既定 policy の YOLO 規則は `toolName = "*"`, `decision = "allow"` である。

- [Configuration: command-line arguments](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md#command-line-arguments)
- [Policy engine: approval modes and rule matching](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md#approval-modes)
- [Built-in YOLO policy](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/policy/policies/yolo.toml)

インストール済み 0.63.0 の `bundle/policies/yolo.toml` も同じで、`ask_user` と plan-mode transition を除く `*` を priority 998 で allow する。`write.toml` の headless deny は priority 10 なので、同じ default tier 内では YOLO allow が勝つ。

よって `run_shell_command` は YOLO の対象に含まれる。`auto_edit` は edit 系だけを自動承認するため、headless の shell には不十分である。

### 2. policy deny は YOLO と別に成立しうる

公式 policy engine は、全 active rule のうち最高優先度の一致規則を採用する。policy の階層は Admin > User > Workspace > Extension > Default で、管理者規則はユーザー設定や既定規則を上書きできる。したがって、上位 tier の deny は既定 tier の YOLO allow より優先される。

`run_shell_command` には `commandPrefix` / `commandRegex` でコマンド単位の allow/deny を書ける。追加 policy は `--policy`、管理 policy は `--admin-policy`、ユーザー policy は `~/.gemini/policies/*.toml`、Windows のシステム policy は `C:\ProgramData\gemini-cli\policies` からロードされる。

- [Policy engine: core concepts, locations, shell syntax](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md)
- [Shell tool](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md)

設定側にも次の制限がある。

- `tools.core`: 値を設定すると、明示した built-in tool だけが有効になる。
- `tools.exclude`: tool を discovery から除外する。
- `tools.confirmationRequired`: allowed tools と core allowlist より優先して確認を要求する。
- `security.disableYoloMode`: CLI flag があっても YOLO を無効化する。

根拠: [Configuration reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)

### 3. workspace trust と policy は同一ではない

untrusted workspace では project settings、環境変数、MCP、custom commands、tool auto-acceptance などが制限される。headless では `--skip-trust` または `GEMINI_CLI_TRUST_WORKSPACE=true` により、そのセッションだけ trust check を通過できる。codex-do は両方を設定しているため、既知の起動構成について trust の許可が欠けているとはいえない。

根拠: [Trusted folders: headless and automated environments](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/trusted-folders.md#headless-and-automated-environments)

trust は「その workspace の機能と設定をロードしてよい」という判断であり、個々の tool call の policy allow を保証しない。

### 4. sandbox と policy denial は区別する

Gemini CLI は full-process sandbox と tool-level sandbox を持つ。sandbox のパス・ネットワーク制限に失敗した場合は sandbox expansion の対象になりうる。一方、今回の主要文言は scheduler の policy check が返す `policy_violation` の固定文言 `Tool execution denied by policy.` である。したがって、この文言だけから sandbox 不足と断定してはいけない。

根拠: [Sandboxing in Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md)

## 現PCと codex-do の静的確認

- `tools/codex-do.mjs` の `buildGeminiArgs`: `-m <model> --approval-mode yolo --skip-trust -p <marker>`
- `buildGeminiEnv`: `GEMINI_API_KEY` と `GEMINI_CLI_TRUST_WORKSPACE=true`
- インストール済み CLI: `@google/gemini-cli` 0.63.0
- `~/.gemini/settings.json`: auth の selectedType のみ。`tools.core`, `tools.exclude`, `tools.confirmationRequired`, `security.disableYoloMode` はない。
- `~/.gemini/policies` と `C:\ProgramData\gemini-cli\policies`: 調査時点では存在を確認できなかった。
- GEMINI/POLICY/SANDBOX 系のプロセス環境変数: 調査時点では設定を確認できなかった。

以上は「現在のPCに永続 deny 設定が見つからない」ことを示すだけで、過去 run 時点の設定や、補助 policy、CLI の過去バージョン、動的に生成された規則を否定する証拠ではない。

### 現起動引数に欠けている許可設定

必須の不足は確認できない。次の候補は存在するが、現在の YOLO と重複するか、別用途である。

- `--allowed-tools "run_shell_command(...)"`: 確認 bypass の明示 allow。現在は非推奨予定で、公式は policy engine への移行を案内している。YOLO が正常に適用されるなら不要。
- `--policy <file>`: `run_shell_command` を allow するユーザー policy を明示ロードできる。ただし admin deny には勝てず、広い allow は安全性を下げる。
- `tools.sandboxAllowedPaths` / sandbox expansion: sandbox のアクセス範囲を広げる設定であり、一般的な policy deny の解除フラグではない。

従って、根拠なく allow policy を追加するより、まず denial 時に一致 rule/source を記録できるようにするのが先である。

## 実行ログからの証拠

`~/.claude/executor-usage.jsonl` を読み取り、gemini-cli chain の denial を抽出した。代表例は次のとおり。

| 時刻 (ログの ISO 値) | 結果 | 秒 | denial | 出力文字 | 証拠要約 |
|---|---:|---:|---:|---:|---|
| 2026-10-25T19:21:02Z | blocked | 300.781 | 旧行のため集計値なし | 旧行のためなし | `run_shell_command: Tool execution denied by policy` が反復 |
| 2026-10-27T07:26:19Z | blocked | 300.763 | 12 | 0 | refusal 後、閾値まで無出力 |
| 2026-10-27T14:05:28Z | blocked | 302.525 | 8 | 0 | 同上 |
| 2026-10-27T21:05:10Z | blocked | 300.797 | 5 | 167 | 低出力のまま停止 |
| 2026-10-28T04:10:18Z | timeout | 600.313 | 4 | 1120 | 600秒を使い切った |
| 2026-10-28T11:11:48Z | exhausted | 432.430 | 3 | 3218 | workspace 外パス拒否も併発 |
| 2026-10-28T11:19:41Z | exhausted | 199.136 | 6 | 663 | ignore pattern による `read_file` 拒否も併発 |
| 2026-10-28T11:29:09Z | blocked | 300.722 | 7 | 0 | `.gemini` が allowed workspace 外 |
| 2026-10-28T14:12:43Z | blocked | 300.680 | 14 | 0 | shell policy refusal が反復 |
| 2026-10-28T22:12:55Z | exhausted | 104.677 | 1 | 718 | denial が1回あっても処理自体は出力を返した |

`~/.claude/delegation-health.json`（`generatedAt=2026-10-28T23:09:35.769Z`）の `fallback_chain_timeout` は、gemini-cli と cheap-code:deepseek の計2件、捨てた時間1501秒を報告している。これは両 backend の合算であり、1501秒すべてを gemini-cli の policy denial に帰属させてはいけない。

## 指示・設定・代替手段による回避可能性

### 指示文

「shell を使わず `read_file` / `glob` / `grep_search` で静的調査する」と明示すれば、読み取り専用タスクは完遂できる可能性がある。これは denial の解除ではなく、拒否対象 tool を呼ばない回避である。今回のように対象コードとログを読むだけの調査には有効である。

テスト実行、ビルド、formatter、git 操作、任意 script の起動が成果条件なら、指示文だけでは代替できない。shell を使わなかった回答を成功扱いしてはならない。

### workspace 設定

workspace 外パスは workspace root または project temp 内へ必要な入力を用意する、あるいは正規の allowed path / sandbox path 設定を使うことで解消しうる。ignore pattern 拒否は対象 pattern の設定を見直す必要がある。ただし codex-do が勝手に security boundary を広げる変更は避けるべきである。

### 別ツール・別 backend

ファイル列挙、検索、読取、編集は専用 tool で置換できる場合がある。shell が必須なら gemini-cli を候補から外し、shell 実行可能性を確認済みの backend へ送るのが確実である。

## codex-do 側の対処案

### 案1: denial の即時分類と早期打ち切りを強化する

現 `POLICY_DENIAL_PATTERN` は以下を検出する。

```text
tool execution denied by policy
resolves outside the allowed workspace directories
ignored by configured ignore patterns
```

今回確認した実ログの主要文言はすべてこの3種で拾えるため、既知文言の不足はない。ただし現在は「300秒以上・出力400字未満・3回以上」を同時に要求するため、拒否が確定しても最大300秒待つ。gemini-cli に限り、同一 tool の policy denial が2～3回出た時点、または無出力30～60秒で打ち切る。workspace/ignore refusal は1回でもパスが同じなら早期打ち切り候補にする。

- 効果: 300～600秒の空費を数十秒へ短縮できる。
- 副作用: モデルが拒否後に専用 tool へ自己修正する機会を早く奪う。2026-10-28T22:12:55Z のような継続可能 run があるため「1拒否で即停止」は強すぎる。
- 実装コスト: 低。既存 `shouldAbortPolicyStall` に backend、同一エラー回数、last-progress 時刻を渡す。

### 案2: gemini-cli 専用 timeout を短縮する

既定600秒を300～360秒に下げる。現在、policy-stall 条件に入らない高出力 run は600秒まで残るため、タイムアウトが最後の防波堤になる。

- 効果: 検出不能な拒否や別種の停滞の最大損失を半減する。
- 副作用: リポジトリ内コメントでは gemini-cli 成功37件の最大が559秒とされており、無条件300秒化は遅い正常 run を切る。
- 実装コスト: 低。`backendSpecificTimeoutSecs` の既定値変更だけ。ただし単独採用より案1との組合せがよい。

推奨は、shell 必須 task では短い上限、静的調査では現行上限という task-aware timeout である。

### 案3: shell 必須タスクでは gemini-cli をフォールバック候補から外す

task metadata または prompt の成果条件から `test`, `build`, `git`, formatter、script 実行、実機検証を shell-required と分類し、gemini-cli の shell capability が事前に保証されない環境では次 backend へ進む。単なるキーワードだけでなく `kind=implement/verify` と要求成果物を組み合わせる。

- 効果: 失敗が予測できる task に300～600秒を使わない。
- 副作用: Gemini CLI が正常なら使えた案件まで除外し、後段 provider の費用・枠を消費する。誤分類の危険がある。
- 実装コスト: 中。task classifier と fallback selection、判定理由のログが必要。

### 案4: denial の rule/source を観測可能にする

policy refusal を記録する際、CLI が提供できる debug/telemetry 情報から、approval mode、interactive 判定、一致 rule の tier/source/priority、tool 名、command の安全な要約を保存する。秘密やコマンド全文は台帳へ残さない。

- 効果: 「YOLOなのになぜ deny か」を次回ログだけで確定でき、不要な allow 追加を防ぐ。
- 副作用: CLI 0.63.0 が一致 rule metadata を通常出力に出さない場合、upstream 対応または限定的な wrapper instrumentation が必要。
- 実装コスト: 中～高。

### 案5: capability circuit breaker を入れる

同一PC・同一Gemini CLI version・同一設定 fingerprint で shell policy denial が連続したら、一定時間 gemini-cli を shell-required task から外す。静的読み取り task には残す。成功した shell run の確かな証拠が得られた場合だけ breaker を戻す。

- 効果: 同じ障害を後続 task で繰り返さない。
- 副作用: 設定変更後も cooldown 中は復旧を利用できない。通常の文章出力成功を shell 復旧と誤認しない設計が必要。
- 実装コスト: 中。version/config fingerprint、TTL、成功条件を台帳化する。

## 推奨順序

1. 案1で gemini-cli の refusal 打ち切りを30～60秒級へ短縮する。ただし1回の拒否だけでは切らない。
2. 案3で shell-required task を routing し、静的調査だけ gemini-cli に残す。
3. 案4で一致 rule/source を収集し、原因確定後に限って policy/config を修正する。
4. 案5を再発防止として追加する。
5. 案2の一律 timeout 短縮は、559秒の既存成功を切るため補助策に留める。

## 未確定事項

- 既存の無理由 denial が一致した具体的な policy rule、tier、source。ログは固定エラー文しか持たない。
- denial 発生 run 当時の Gemini CLI version と、現在の0.63.0との policy挙動差。
- run 時だけ注入された `--policy` / `--admin-policy`、system settings、動的 policy の有無。
- policy denial 後にモデルが shell を再試行し続けるか、専用 tool へ自己修正するかを決めるモデル側条件。
- 明示的 `--allowed-tools run_shell_command` または allow TOML が当該環境の refusal を解消するか。安全制約に従い実行検証していない。なお admin deny が原因なら解消しない。
- policy-stall 閾値を30秒、60秒、あるいは拒否回数ベースのどれにすべきか。実運用ログで false positive を評価する必要がある。

これらは推定で埋めず、未確定のまま扱う。
