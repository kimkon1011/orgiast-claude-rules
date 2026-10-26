## 真因

10/23〜26の nightly-batch ログの個別 error 行を集計し、6処理13件を確認（サマリ行は重複計上しない）。OrgiastNightlyKpi は集計タスクで、各処理を実行する nightly-batch とは別。nightly-batch は失敗を記録して後続を継続し、Finish-Nightly に渡されたコードで終了するため、プロセス exit 0 は内部全処理成功を意味しない。

| 処理 | 件数 | 確認できた原因・限界 |
| --- | ---: | --- |
| feedback-zero-sweep | 4 | 旧 runGh の Windows shell 経由で検索式の引用符が破損。今回も同じ起動方式で unknown argument を再現。直接起動に修正済みでも cr568/warehouse-app は GraphQL repository 解決失敗。認証済み kimkon1011 から閲覧不可またはリポジトリ不存在・名称変更が候補で、権限不足だけには断定できない。 |
| session-auto-close | 2 | LLM失敗。10/23は Groq daily_limit、10/24は http_429 の cooldown を記録。他の対象で出る「構造上の事実: 特になし」だけでは失敗の末端原因は不明。 |
| stalled-session-resume | 3 | 10/23・24は timeout、10/26は failure により aborted=true。26日の子処理の末端原因はログ末尾だけでは不明。 |
| memory-publish | 2 | 10/23は Vercel deploy ETIMEDOUT、10/26は operation aborted due to timeout。除外ファイルの表示自体が失敗原因ではない。ネットワーク側の末端原因は未確定。 |
| stale-work-watch | 1 | 10/24に gh と git の spawnSync ETIMEDOUT。滞留案件の検出そのものと収集失敗を区別。 |
| webhook-health | 1 | 10/25に fleet sheet が busy 応答を返した。再試行対策は既存コミット7265ce6 / PR #1126に実装済み。 |

証拠: C:/Users/uers/.claude/logs/nightly-batch-2026-10-{23,24,25,26}.log。抽出行は専用 worktree の .evidence/failures.json に保存。

ad363df の alternates を C:/Users/uers/.claude/nightly-repo/.git/objects に修正し、Windows Git の log -3 --stat で ad363df / 7265ce6 / 540ea0e を確認。origin/main から指定の新 worktree を作り、完全SHAをfetchして cherry-pick --no-commit。診断保持とKPI途中集計対策は PR #1159（2026-10-26T11:37:07Z merge、337f156）にすでに含まれ、差分は空だった。重複実装せず、例外経路の秘密マスクと起動エラー・stderr併記を補完した。

## PR

https://github.com/kimkon1011/orgiast-claude-rules/pull/1168

`gh pr view 1168 --repo kimkon1011/orgiast-claude-rules --json state,url,headRefName` で state=OPEN を確認。マージしていない。
ブランチ: fix/nightly-kpi-diag-log-20261027
コミット: 3f0b89e（日本語メッセージ、指定Co-Authored-By付き）
worktree: C:/Users/uers/.claude/nightly-repo/.wt/nightly-kpi-pr-20261027
変更: 例外も通常失敗と同じマスク・1行500文字制限を適用し、起動エラーがあってもstderrを保持。回帰テストを追加。

## テスト結果

Windows PowerShellからWindows Node v24.22.1で実行。
作業ディレクトリ: C:/Users/uers/.claude/nightly-repo/.wt/nightly-kpi-pr-20261027

```text
node --test tools/feedback-to-issues.test.mjs tools/nightly-kpi.test.mjs tools/feedback-zero-sweep.test.mjs
84 tests / 84 pass / 0 fail / 0 skipped / exit code 0
```

git diff --check 成功。ログ: .wt/nightly-kpi-pr-20261027/.evidence/tests.log

## stderr 採取結果

採取日時: 2026-10-26T17:58:15.653Z（2026-10-27 JST）。Windows PowerShell -NoProfile → Windows Node、ユーザー uers、cwd `C:\Users\uers\.claude\nightly-repo`。現行 feedback-zero-sweep の loadConfig/appConfig/fetchPending/normalizeItem を用いて倉庫アプリのライブ原票から引数を取得。原票は読み取りのみ。runGh と旧 shell 起動を各1回実行し、再試行なし。

過去のタスク実行時の環境変数スナップショットは無いため、同じWindowsユーザー・cwd・コード経路での現在環境の再現であり、当時の環境の完全一致は保証できない。営業側原票の取得は「JSONでない応答」で失敗したため、同じ失敗対象である倉庫側を採取した。

引数配列（shellでの再引用を避け直接渡した実値）:
```json
[
  "issue",
  "list",
  "--repo",
  "cr568/warehouse-app",
  "--state",
  "all",
  "--search",
  "\"feedback-dm:1560226657544048702\" in:body",
  "--json",
  "number,url,body",
  "--limit",
  "100"
]
```

現行runGh（直接起動）: exit code 1

stdout先頭20行:
```text
空
```

stderr全文:
```text
GraphQL: Could not resolve to a Repository with the name 'cr568/warehouse-app'. (repository)

```

旧runGh相当（shell=true、同じ引数）: exit code 1

stdout先頭20行:
```text
空
```

stderr全文:
```text
unknown argument "in:body --json number,url,body --limit 100"; please quote all values that have spaces

Usage:  gh issue list [flags]

Flags:
      --app string         Filter by GitHub App author
  -a, --assignee string    Filter by assignee
  -A, --author string      Filter by author
  -q, --jq expression      Filter JSON output using a jq expression
      --json fields        Output JSON with the specified fields
  -l, --label strings      Filter by label
  -L, --limit int          Maximum number of issues to fetch (default 30)
      --mention string     Filter by mention
  -m, --milestone string   Filter by milestone number or title
  -S, --search query       Search issues with query
  -s, --state string       Filter by state: {open|closed|all} (default "open")
  -t, --template string    Format JSON output using a Go template; see "gh help formatting"
  -w, --web                List issues in the web browser
  

```

gh auth status: exit code 0

stdout先頭20行:
```text
github.com
  ✓ Logged in to github.com account kimkon1011 (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: [REDACTED]
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

```

stderr全文:
```text
空
```

認証のToken行は伏せた。秘密値は保存していない。採取JSON: .wt/nightly-kpi-pr-20261027/.evidence/capture.json。

## 未完了・次の 1 手

PR作成・OPEN確認・84件pass・実stderr/exit code採取は完了。既存パッチは取り込み済みのため今回のPRは診断の残存欠落経路の補強。
次の1手は cr568/warehouse-app の存在・現在の名称と kimkon1011 の閲覧権限を所有者側で確認すること。認証成功だけでは当該repoへのアクセスを保証しない。Issue作成・close・コメント等は実行していない。
その他処理の末端原因が不明な箇所は上表に明示。全失敗の恒久解消や本番反映を完了扱いにはしていない。
共有ツリーのcheckout/reset/index変更は行っていない。作業中に外部処理で共有HEADがdetachedへ変化し、最初の.autopilot証跡ディレクトリが消失したため、証跡と本報告のバックアップを専用worktree内に保存した。
