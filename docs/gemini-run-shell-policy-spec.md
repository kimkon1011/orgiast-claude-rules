# gemini-cli `run_shell_command` policy 拒否の仕様調査

調査日: 2026-10-29  
対象: `tools/codex-do.mjs`、`~/.claude/executor-usage.jsonl`、`~/.claude/delegation-health.json`、ローカルにインストールされた `@google/gemini-cli` 0.63.0、Gemini CLI 公式ドキュメント／公式リポジトリ  
調査方法: 静的解析のみ。Gemini CLI や Codex を起動した再現試験、`run_shell_command` の実行試験、拒否回避試験は実施していない。

## 結論

1. `--approval-mode yolo` は、通常なら確認が必要なツール呼び出しを自動承認するモードであり、`run_shell_command` も対象に含む。公式の既定policyには YOLO 用の allow-all がある。
2. ただし YOLO はpolicy engineや安全チェックを無効化しない。より上位tier／高優先度の `deny`、コマンド制限、設定によるツール除外、admin policy、安全チェッカー等が拒否すれば実行されない。非対話モードでは、最終判断が `ask_user` のままなら承認画面を出せないため `deny` として扱われる。
3. `codex-do.mjs` は既に `--approval-mode yolo --skip-trust` を渡し、`GEMINI_CLI_TRUST_WORKSPACE=true` も設定している。一般公開されているCLI引数の範囲では、全shell実行をさらに包括的に許可する「欠けている必須フラグ」は確認できなかった。`--allowed-tools` は確認省略用であり、上位の明示的denyを覆す万能フラグではない。
4. 現在のPCでは `~/.gemini/settings.json` に認証方式しかなく、ユーザーpolicy (`~/.gemini/policies`) と管理者policy (`C:\ProgramData\gemini-cli\policies`) は存在しなかった。したがって、現在見える永続設定だけから当時の拒否原因を特定できない。
5. ログは拒否されたコマンド引数、マッチしたruleのsource／priority、Gemini CLIの当時のversionを保存していない。このため「どのrule／安全チェックが拒否したか」は未確定である。現行0.63.0のコードでは、rule不一致かつYOLOならallowになるため、単なる承認不足だけでは観測ログを説明できない。

## 確定できた仕様

### 1. YOLOが承認する範囲

公式configuration referenceは `--approval-mode yolo` を「すべてのtool callを自動承認」と定義し、`auto_edit` は `replace`／`write_file` の編集系だけを自動承認すると説明している。したがってshellを必要とする非対話処理に `auto_edit` を使うのは代替にならず、`codex-do` がYOLOを選ぶ方向自体は仕様に合っている。

- 公式: [Configuration / command-line arguments](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md#command-line-arguments)
- 公式: [Policy engine / default policies](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md#default-policies)

公式policy engine docsは、既定policyについて「write tools（`write_file`, `run_shell_command`）は通常 `ask_user`」「YOLOでは高優先度のruleが全toolをallow」としている。ローカル0.63.0のbundleも、ruleが一件もmatchしない場合はYOLOなら `ALLOW` にする実装である。

### 2. YOLOでも拒否される条件

policy engineは、tool名、引数、approval mode、interactive/non-interactive条件に合うruleを評価し、優先順位が最も高いruleの `allow`／`deny`／`ask_user` を採用する。policy tierは Default < Extension < Workspace < User < Admin で、上位tierが優先される。mode未指定のruleはYOLOを含む全modeで有効である。

- 公式: [Policy engine / core concepts and priority](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md#core-concepts)
- 公式: [Policy engine / policy locations](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md#policy-locations)

よって、以下ではYOLOでも拒否されうる。

- User／Admin／Extension等のruleが、対象の `run_shell_command` またはコマンドprefix／regexを `deny` にする。
- ruleが `ask_user` を返し、`-p` の非対話実行で確認できない。公式docsは「non-interactiveでは `ask_user` を `deny` として扱う」と明記する。
- `tools.core` が設定され、`run_shell_command` または対象コマンドがallowlistにない。
- `tools.exclude`（deprecatedだが有効）またはpolicy ruleが対象をblockする。blocklistはallowlistより優先する。
- `tools.confirmationRequired`、adminのsecure mode、`security.disableYoloMode` 等の管理設定が効く。後二者は通常、YOLO起動そのものを設定エラーにするため、今回の「tool呼び出し時だけ拒否」とは形が異なる。
- safety checkerがdenyする。ローカル0.63.0のpolicy engineはrule決定後にもcheckerを実行し、denyなら最終的に拒否する。
- shell commandを分割して各sub-commandを検証した結果、いずれかがdenyされる。公式shell docsも、`&&`、`||`、`;` の各部分を検証し、一部が不許可なら全体をblockすると説明する。

公式shell docs: [Shell tool / command restrictions](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md#command-restrictions)

### 3. workspace trust、sandbox、policyは別レイヤー

`--skip-trust` は「このsessionで現在のworkspaceをtrustする」フラグである。ローカルコードでは、workspaceがuntrustedならYOLOをdefault modeへ落とす。一方、workspaceをtrustしてもpolicy ruleや安全チェックを無効化しない。

- 公式ソース: [CLI config (`--skip-trust` とapproval mode)](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)

Sandboxも別レイヤーである。`--sandbox` はsandboxを有効化するフラグであり、policy allowそのものではない。sandbox外の権限拡張が必要な場合は追加承認が発生しうる。逆にsandboxを付けないことは、policy denyの解除を意味しない。

- 公式: [Sandboxing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md)

`codex-do` は `--skip-trust` と `GEMINI_CLI_TRUST_WORKSPACE=true` を両方設定している。この二重指定に害がある証拠はないが、いずれもshell policyのdenyを上書きする設定ではない。

### 4. 現起動引数に欠けている許可設定

**確定:** 公開CLI仕様上、一般的な全tool自動承認に必要な指定は既に `--approval-mode yolo` で満たしている。workspace trustも `--skip-trust` で満たしている。

**条件付きの設定:** `--allowed-tools`、`tools.core`、追加policy (`--policy`) で特定コマンドをallowできる。ただし用途は限定的である。

- `--allowed-tools` は確認dialogをbypassする指定であり、上位tierのdeny／admin policy／safety checkerを無効化する仕様とは書かれていない。
- `tools.core: ["run_shell_command"]` はshell toolをallowlistに含める。現在のsettingsには `tools.core` 自体がないので、今回これを足せば直るとは言えない。
- user policyで `run_shell_command` または必要なcommand prefixを `allow` にできる。ただしadmin tierのdenyには勝てず、無制限allowは安全性を下げる。
- redirectionを含む限定allow ruleでは `allowRedirection = true` が必要になりうる。ただし現行コードはYOLO時の一般allowについてredirection downgradeをしない。今回のログには実コマンドがないため、redirection起因とは確定できない。

したがって、原因ruleを観測せずに「allow-all policyを追加」する対処は採らない。まずpolicy decisionのsource、priority、commandをログへ残すべきである。

### 5. 指示文や別toolによる回避可能性

- 読み取り・検索・ファイル編集だけで完結する作業は、`read_file`、`grep_search`、`glob`、`write_file`、`replace` 等の専用toolを使うよう指示すればshell依存を減らせる。これはpolicyの迂回ではなく、必要権限の小さいtoolへの置換である。
- テスト、formatter、git、package manager、任意scriptなどOS processの起動が必要な作業は `run_shell_command` が主要手段であり、専用toolだけでは同等に検証できない。そうしたタスクでshellがdenyされれば、Gemini CLIは実装完了条件を満たせない可能性が高い。
- promptの書き方だけで明示的denyを解除できる仕様はない。同じshell callを言い換えて再試行させることは、停滞やpolicy回避の誘発になるため対処として採用しない。
- 明示的に「shellを使わず、利用可能な専用toolだけで行い、不可能なら即座に理由を返す」と指示することは、read/edit中心タスクの安定化には有効。ただしshell必須タスクの代替ではない。

## 実行ログの証拠

`~/.claude/executor-usage.jsonl` から、policy拒否を含む代表例を抽出した。時刻はJSONLのUTC (`t`)。

| 日時 (UTC) | kind | Gemini試行 | 観測 |
|---|---:|---:|---|
| 2026-10-17 15:53:11 | implement | 414.518秒 | `run_shell_command` 拒否2回、出力0、exit 1 |
| 2026-10-25 19:21:02 | implement | 300.781秒 | 拒否3回以上、出力0。codex-doが `blocked` と記録 |
| 2026-10-27 07:26:19 | implement | 300.763秒 | `policyDenials: 12`、出力0、早期打ち切り |
| 2026-10-27 14:05:28 | verify | 302.525秒 | `policyDenials: 8`、出力0、早期打ち切り |
| 2026-10-27 21:05:10 | verify | 300.797秒 | `policyDenials: 5`、出力167文字、早期打ち切り |
| 2026-10-28 04:10:18 | verify | 600.313秒 | `policyDenials: 4`、出力1120文字のため400文字条件を外れ、600秒timeout |
| 2026-10-28 14:12:43 | verify | 300.680秒 | `policyDenials: 14`、出力0、早期打ち切り |

共通文言は次のとおり。

```text
Error executing tool run_shell_command: Tool execution denied by policy.
```

同ログには、`read_file` が「allowed workspace外」「configured ignore patterns」により拒否された別系統もある。これらは現在の `POLICY_DENIAL_PATTERN` に追加済みだが、`run_shell_command` のdeny原因そのものを示すものではない。

`~/.claude/delegation-health.json`（生成日時 2026-10-28T15:13:25.952Z）は `fallback_chain_timeout` として2件、backend `gemini-cli, cheap-code:deepseek`、廃棄時間合計1501秒を記録している。これはフォールバックの時間損失を裏付けるが、policy ruleの内容は記録していない。

## `codex-do` 現実装の評価

### 拒否検出

`POLICY_DENIAL_PATTERN` は次を検出する。

```regex
/tool execution denied by policy|resolves outside the allowed workspace directories|ignored by configured ignore patterns/gi
```

今回ログの主要文言 `Tool execution denied by policy.` は大文字小文字無視で一致するため、主要パターンは足りている。ローカルGemini CLI 0.63.0には、shell prompt injectionの事前検査で使われる別文言 `Reason: Blocked by policy.` も存在する。現在の実ログには出ていないが、将来同じ停滞分類に含める候補である。また公式policyはcustom `denyMessage` を付加できるが、先頭の標準文言は維持される。

現条件は「300秒以上、出力400文字未満、拒否3回以上」。出力1120文字だった2026-10-28 04:10の例は拒否4回でも打ち切られず600秒を消費した。`outputChars` の上限は、policy拒否後に説明文を返すモデルほど検出を逃す。

### timeout

`backendSpecificTimeoutSecs('gemini-cli')` は既定600秒である。一方、policy stallは最短300秒で打ち切る。したがって拒否回数／出力量条件を満たさない拒否は最大600秒残る。調査対象の障害に限れば長すぎる。

### タスク適合性

現在のfallback選択は、タスクがshell実行を必要とするかを見てGemini CLIを除外しない。`verify`、テスト実行、git状態確認、依存関係操作などはshell依存が強く、shell不可のGeminiを先に600秒待つ期待値が低い。

## 対処案

### 案1: policy拒否を即時かつ状態ベースで打ち切る（推奨、最優先）

Gemini backendに限り、同一試行で標準policy拒否が2～3回出た時点、または最初の拒否から短い猶予（例30～60秒）後に進展がなければ終了する。総出力文字数400未満という条件は外し、「拒否後に成功したtool call／ファイル変更／有意な進行があったか」で判定する。追加候補文言として `Blocked by policy`、`Shell command confirmation required`、`confirmation required` を、promptのecho誤検知を避けたうえで検討する。

- 効果: 現在300～600秒失うケースを数十秒に縮める。説明文が長いだけの停滞も止められる。
- 副作用: 一部shell callだけ拒否され、専用toolで回復できるタスクを早く切る可能性。Gemini backend限定、拒否後の成功tool／diffを見て緩和する。
- 実装コスト: 低～中。既存 `shouldAbortPolicyStall` と実行streamのカウンタ拡張で対応可能。

### 案2: Gemini専用timeoutを短縮する

既定600秒を120～300秒へ短縮する。少なくとも `verify` やshell必須判定時は120～180秒、read/edit中心は従来値など、task kindで分ける。

- 効果: 未知の拒否文言や検出漏れでも損失上限を確実に抑える。
- 副作用: ログコメント上、Gemini成功例は最大559秒であり、全タスク一律短縮だと遅いが成功する処理を切る。
- 実装コスト: 低。`backendSpecificTimeoutSecs` にkind／shellRequiredを渡す変更とテストが中心。

### 案3: shell必須タスクではGeminiを候補から外す

task kindと指示文から、テスト・build・formatter・git・package manager・script実行等を要求するタスクを保守的に分類し、Gemini CLIをskipする。明示的な「静的解析のみ」「ファイル読取／編集のみ」は候補に残す。

- 効果: shell権限が使えない状態で、成功可能性の低いbackendへ時間を使わない。
- 副作用: Gemini側のpolicyが正常な環境でも候補を外し、fallback選択肢とquota分散を減らす。自然言語分類の誤判定もある。
- 実装コスト: 中。分類器、override環境変数、ログ理由、テストが必要。

### 案4: shellなしで完結できるtask用promptを分ける

Gemini候補を残す場合は「shellを使わない。専用のread/search/edit toolだけを使う。shellが必要なら繰り返さず、即座に `SHELL_REQUIRED` を返す」というbackend固有system instructionを加える。`SHELL_REQUIRED` をcodex-doが即検出して次backendへ進む。

- 効果: read/edit中心のタスクをGeminiで処理しつつ、同じ拒否の反復を防ぐ。
- 副作用: テスト未実行の変更を完了扱いにしないcompletion gateが必要。モデルが指示に従わない可能性もある。
- 実装コスト: 低～中。prompt、結果分類、empty-diff／verification判定を調整する。

### 案5: 原因ruleを観測可能にする（診断の前提として推奨）

Gemini CLIのdebug出力またはstream-jsonで、拒否tool名、command（secret redaction後）、matched ruleのsource／priority／decision、CLI version、active policy一覧の識別情報を台帳へ保存する。通常実行でcommand全文を無条件保存すると秘密が混ざるため、root commandとhash、redacted snippet程度に制限する。

- 効果: 次回は「admin deny」「allowlist漏れ」「redirection」「safety checker」等を区別でき、推測でallow設定を追加せずに済む。
- 副作用: ログ量と機密情報リスクが増える。Gemini CLIが非debug出力にrule sourceを出さない場合は取得不能。
- 実装コスト: 中。出力形式調査、redaction、ledger schema変更が必要。

### 案6: 最小権限の明示policyを使う（原因判明後のみ）

必要なroot commandだけを `commandPrefix` でallowする追加policyを作り、必要なら `allowRedirection = true` を限定的に付ける。`run_shell_command` 全体のallowは避ける。admin denyやsafety checkerが原因なら解消しないため、案5で原因を確認してから採用する。

- 効果: allowlist不足が原因なら、YOLOより狭い範囲で実行可能にできる。
- 副作用: コマンドprefix設計を誤ると権限が広すぎる。shell wrapper、chain、引数注入も考慮が必要。上位denyには無効。
- 実装コスト: 中。必要command棚卸し、policy生成、security reviewが必要。

## 推奨順序

1. 案1でpolicy stallを30～60秒級へ短縮し、`outputChars < 400` 依存をやめる。
2. 案5で拒否rule／command／CLI versionの観測を追加する。
3. 案3または案4でshell必須とshell不要を分ける。
4. 全体の安全網として案2のGemini timeoutを300秒以下にする。ただし成功時間分布を再集計してkind別に設定する。
5. 原因がallowlist不足と確定した場合だけ案6を適用する。

## 変更案diff（参考、未適用）

成果物以外のファイルは変更していない。以下は方向性を示す擬似diffであり、そのまま適用する完成patchではない。

```diff
-export const POLICY_DENIAL_PATTERN = /tool execution denied by policy|resolves outside the allowed workspace directories|ignored by configured ignore patterns/gi;
+export const POLICY_DENIAL_PATTERN = /tool execution denied by policy|blocked by policy|shell command confirmation required|resolves outside the allowed workspace directories|ignored by configured ignore patterns/gi;

-export const POLICY_STALL_MIN_ELAPSED_SECS = 300;
-export const POLICY_STALL_MIN_OUTPUT_CHARS = 400;
+export const POLICY_STALL_MIN_ELAPSED_SECS = 60;
+// Geminiでは総文字数でなく、拒否後のtool成功・diff・進行eventの有無を使う。

 export function backendSpecificTimeoutSecs(backendName, env = process.env) {
   if (backendName !== 'gemini-cli') return null;
   const raw = Number(env.CODEX_DO_GEMINI_TIMEOUT_SECS);
-  return Number.isFinite(raw) && raw > 0 ? raw : 600;
+  return Number.isFinite(raw) && raw > 0 ? raw : 300;
 }
```

## 未確定事項

- 各拒否時にGemini CLIが実際に要求したcommandと引数。JSONLには保存されていない。
- 拒否にmatchしたruleのsource、tier、priority、またはsafety checker名。
- 2026-10-17～28各実行時のGemini CLI version。現在インストールされているのは0.63.0だが、過去実行も同versionだった証拠はない。
- 実行時に一時的な `--policy`／`--admin-policy`、別settings path、extension policy、環境変数が注入されていたか。
- 2026-10-28 04:10の600秒例で、拒否後に何を280 output tokens／1120文字返していたか。台帳はtailしか保持しない。
- `--allowed-tools` または限定allow policyで当該障害が解消するか。安全制約に従い実行実験をしていないため未確定。
- promptで専用toolだけを使わせた場合の成功率。これは仕様ではなく運用品質の問題であり、静的解析からは確定できない。

以上より、「Gemini CLIはYOLOでもshell権限が原理的に無い」と一般化するのは不正確である。正確には、YOLOは通常のshell確認を自動承認するが、観測された実行では別のpolicy判断がdenyを返しており、その具体的なruleは現ログだけでは特定不能、である。
