# 倉庫アプリ repo 調査 2026-10-27

## 真因

確定した直接原因: kimkon1011 で認証した Linux gh・Windows gh.exe の双方から `cr568/warehouse-app` を解決できない。不存在／改名／権限不足の内訳は未確定。404 だけで権限不足や不存在とは断定しない。正名を確定できなかったため、指示の「設定を変更せず報告」分岐を実施した。

- `gh api /repos/cr568/warehouse-app`: exit 1、stdout は status=404 / message=Not Found、stderr は `gh: Not Found (HTTP 404)`。full_name やリダイレクト先は得られず。
- `gh issue list -R cr568/warehouse-app --limit 1 --json number`: Linux・Windows とも exit 1、stdout 空、stderr は `GraphQL: Could not resolve to a Repository with the name 'cr568/warehouse-app'. (repository)`。
- `gh repo list cr568 --limit 100`: exit 0、3件（orgiast-claude-rules / checklist / cr）。
- `gh repo list seisaku-team-org --limit 100`: exit 0、5件。`gh repo list kimkon1011 --limit 200`: exit 0、19件。いずれも warehouse / 倉庫 / souko / stock / inventory に対応する名前・説明は見当たらない。
- `gh search repos warehouse --owner cr568 --owner seisaku-team-org --owner kimkon1011`: exit 0、stdout/stderr 空。
- `gh auth status`: Linux・Windows とも active account=kimkon1011、exit 0。`gh api user/orgs --jq '.[].login'`: exit 0、出力空（この認証で返る所属 org はなし）。
- Downloads 直下の「倉庫」を含むフォルダ: 0件。対象 remote 確認なし。
- projects 配下 *.jsonl の `warehouse-app|倉庫アプリ` 抜粋を50行上限で保存。追加の owner/warehouse-app 検索では現行名の設定・失敗記録が見つかったが、成功した代替 repo 名は確認できず。検索は件数を制限しており全履歴不存在の証明ではない。
- 登録元 PR #763 https://github.com/kimkon1011/orgiast-claude-rules/pull/763 は `cr568/warehouse-app` を記載している。記載された68テスト成功は登録処理の検証であり、当該 repo の存在や Issue API 成功の証明ではない。

候補一覧:

| 候補 | 根拠 | 判定 |
| --- | --- | --- |
| cr568/warehouse-app | 現行設定、登録元 PR #763、過去ログ | 唯一の具体名だがアクセス不可。正名として確定できない |
| 改名・移転先 | 3所有者の一覧・検索で探索 | 具体的候補なし |

存在が cr568 側で確認でき、kimkon1011 が未招待の場合は、所有者 cr568 が https://github.com/cr568/warehouse-app/settings/access から kimkon1011 を招待する。これは条件付きの次手であり、権限不足を確定したものではない。

## 変更

変更なし。tools/feedback-apps.json を含むコード・設定は編集していない。正名未確定のため修正用 worktree・ブランチ・PR は作成せず、commit/push も実施していない。
報告書と証拠のみ作成。証拠ディレクトリ `.wt/warehouse-repo-evidence-20261027/` はログ保存用の通常ディレクトリであり git worktree ではない。

## 検証

gh issue list は Linux・Windows 双方 exit 1。成功する正名は未発見で、夜間バッチの解消は未達。
コード変更なしのためテスト未実行。package.json に test スクリプトはない。前周84 pass・PR #763の68 passを今回の検証結果として流用していない。
結果ファイル指定先 `C:\Users\uers\.claude\autopilot-codex-result-20261027-warehouse-repo.md` は本セッションの書込み許可範囲外のため未作成。代替は nightly-repo 直下の同名ファイル。

## kim への質問

cr568 の所有者アカウントで `https://github.com/cr568/warehouse-app` を開くと、倉庫アプリのリポジトリが表示されますか（はい／いいえ）？


## コマンド実測証拠

### repo-api

```json
{
  "command": [
    "gh",
    "api",
    "/repos/cr568/warehouse-app"
  ],
  "exit": 1,
  "stdout": "{\"message\":\"Not Found\",\"documentation_url\":\"https://docs.github.com/rest/repos/repos#get-a-repository\",\"status\":\"404\"}",
  "stderr": "gh: Not Found (HTTP 404)\n"
}
```

### repos-cr568

```json
{
  "command": [
    "gh",
    "repo",
    "list",
    "cr568",
    "--limit",
    "100"
  ],
  "exit": 0,
  "stdout": "cr568/orgiast-claude-rules\t\tpublic, fork\t2026-10-26T16:41:28Z\ncr568/checklist\tオージャスト 当日チェックリスト（配布用ページ）\tpublic\t2026-10-18T10:15:00Z\ncr568/cr\t\tpublic\t2026-07-07T10:07:13Z\n",
  "stderr": ""
}
```

### repos-org

```json
{
  "command": [
    "gh",
    "repo",
    "list",
    "seisaku-team-org",
    "--limit",
    "100"
  ],
  "exit": 0,
  "stdout": "seisaku-team-org/makimono-cli\tMCP server + CLI for Makimono — a marketplace of AI instruction files (Markdown). npx -y makimono-mcp\tpublic\t2026-10-03T12:13:42Z\nseisaku-team-org/makimono-listings\t出品リポジトリ: Markdown を1ファイル足す PR で マキモノ に掲載されます / Playbook listings for Makimono\tpublic\t2026-09-16T05:52:26Z\nseisaku-team-org/makimono-plugin\tマキモノ — AI指示書(MDファイル)マーケットのClaude Codeプラグイン。開発タスクのたびにAIが自動で最適な指示書を探して読み込み、トークンを大幅節約。\tpublic\t2026-07-13T04:50:23Z\nseisaku-team-org/google-drive-backup\tGoogle Drive 内のフォルダを「Copy of XXX」として同じ親階層に複製する Web アプリ\tpublic\t2026-05-29T10:23:09Z\nseisaku-team-org/chatgpt\t\tpublic\t2026-04-20T00:46:26Z\n",
  "stderr": ""
}
```

### repos-kim

```json
{
  "command": [
    "gh",
    "repo",
    "list",
    "kimkon1011",
    "--limit",
    "200"
  ],
  "exit": 0,
  "stdout": "kimkon1011/orgiast-claude-rules\tオージャスト Claude Code 共通ルール (ONBOARDING) - 社内配布用\tpublic\t2026-10-26T18:53:06Z\nkimkon1011/construction-manual-app\t\tprivate\t2026-10-26T11:37:17Z\nkimkon1011/aujust-sales-automation\t\tprivate\t2026-10-26T10:53:27Z\nkimkon1011/booth-production-app\tブース制作アプリ(GAS) 実行パネル・見積・施工計画・原価粗利。clasp 管理\tprivate\t2026-10-26T06:24:46Z\nkimkon1011/exhibition-overlap-checker\t\tprivate\t2026-10-24T20:06:56Z\nkimkon1011/tanom-ai\t\tprivate\t2026-10-23T07:29:03Z\nkimkon1011/tetsuko-unified\t\tprivate\t2026-10-23T05:12:42Z\nkimkon1011/visionwatch-lp\t\tprivate\t2026-10-23T04:15:16Z\nkimkon1011/godo-setsumeikai\t\tprivate\t2026-10-23T04:15:06Z\nkimkon1011/eo-learning-planner\tEO Tokyo Central ビジネスラーニング委員会向け 告知物自動生成アプリ\tprivate\t2026-10-23T04:11:37Z\nkimkon1011/purchasing-management-app\tオージャスト購買部管理アプリ（マニュアル参照不要・モバイルファースト・freee自動投入・許可リスト認証）\tprivate\t2026-10-23T04:11:27Z\nkimkon1011/makimono-sns-poster\t\tprivate\t2026-10-20T08:48:36Z\nkimkon1011/tanom-sns-poster\t\tprivate\t2026-10-15T16:30:58Z\nkimkon1011/orgiast-memoryserve\tkim-PC の Claude Code memory を全社PCへ配る配信口（認証は orgiast-keyserve /api/keys へ委譲）\tprivate\t2026-10-15T10:31:55Z\nkimkon1011/orgiast-keyserve\t\tprivate\t2026-10-02T11:09:37Z\nkimkon1011/orgiast-weekly-bot\t\tprivate\t2026-08-31T16:19:19Z\nkimkon1011/plaud-audio-proxy\t\tprivate\t2026-08-20T10:58:19Z\nkimkon1011/gakkai-sponsor-cron\tDaily routine cron trigger for sponsor.gakkaisupport.jp (GitHub Actions replacement for Vercel Hobby cron)\tprivate\t2026-06-21T21:28:17Z\nkimkon1011/free-website-campaign\tホームページ無料制作キャンペーン サンプル＆提案書\tpublic\t2026-05-19T02:30:03Z\n",
  "stderr": ""
}
```

### search

```json
{
  "command": [
    "gh",
    "search",
    "repos",
    "warehouse",
    "--owner",
    "cr568",
    "--owner",
    "seisaku-team-org",
    "--owner",
    "kimkon1011"
  ],
  "exit": 0,
  "stdout": "",
  "stderr": ""
}
```

### linux-auth

```json
{
  "command": [
    "gh",
    "auth",
    "status"
  ],
  "exit": 0,
  "stdout": "github.com\n  ✓ Logged in to github.com account kimkon1011 (/home/kim/.config/gh/hosts.yml)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n",
  "stderr": ""
}
```

### windows-auth

```json
{
  "command": [
    "/mnt/c/Program Files/GitHub CLI/gh.exe",
    "auth",
    "status"
  ],
  "exit": 0,
  "stdout": "github.com\n  ✓ Logged in to github.com account kimkon1011 (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n",
  "stderr": ""
}
```

### orgs

```json
{
  "command": [
    "gh",
    "api",
    "user/orgs",
    "--jq",
    ".[].login"
  ],
  "exit": 0,
  "stdout": "",
  "stderr": ""
}
```

### issue-current

```json
{
  "command": [
    "gh",
    "issue",
    "list",
    "-R",
    "cr568/warehouse-app",
    "--limit",
    "1",
    "--json",
    "number"
  ],
  "exit": 1,
  "stdout": "",
  "stderr": "GraphQL: Could not resolve to a Repository with the name 'cr568/warehouse-app'. (repository)\n"
}
```

### windows-issue-current

```json
{
  "command": [
    "/mnt/c/Program Files/GitHub CLI/gh.exe",
    "issue",
    "list",
    "-R",
    "cr568/warehouse-app",
    "--limit",
    "1",
    "--json",
    "number"
  ],
  "exit": 1,
  "stdout": "",
  "stderr": "GraphQL: Could not resolve to a Repository with the name 'cr568/warehouse-app'. (repository)\n"
}
```

### registration-pr

```json
{
  "command": [
    "gh",
    "pr",
    "view",
    "763",
    "-R",
    "kimkon1011/orgiast-claude-rules",
    "--json",
    "title,body,url"
  ],
  "exit": 0,
  "stdout": "{\"body\":\"## 何を\\n\\n倉庫アプリ（`cr568/warehouse-app`）を §2.11 の不具合・要望フォーム基盤に登録する。\\n\\n- `tools/feedback-apps.json` に `\\\"倉庫アプリ\\\": \\\"cr568/warehouse-app\\\"` を追加\\n  → `feedback-form-gate.mjs` の `isRegistered()` が通り、完了報告の台帳登録ゲートを満たす\\n- `tools/feedback-zero-registry.json` に `FEEDBACK_BBB271DAAB67` エントリを追加（kind: gas / intake: relay）\\n- registry を1行 JSON からインデント展開に整形\\n\\n## なぜ\\n\\n2026-10-13 09:59 に feedback-kit install が倉庫アプリに対して走り、`tools/.feedback-zero-local.json`（gitignore 済）と\\ntracked 2ファイルの変更が生成されたが、コミットされないまま auto-session rescue 枝4本\\n（`rescue/auto-session-20261013-100002` / `100402` / `103002` / `163002`）に退避されていた。\\n100002 / 103002 / 163002 は blob 一致（apps=`9cfbc74888` + registry=`7a3e565599`）、100402 は registry のみの部分形。\\n\\nキーの正当性: `install.mjs` の `'FEEDBACK_' + sha256(appName).hex.slice(0,12).toUpperCase()` を再計算 → `FEEDBACK_BBB271DAAB67` 一致（手書きではない）。\\n\\n## 検証\\n\\n- origin/main `e3924c4` 上にこの2ファイルを載せて:\\n  `node --test tools/feedback-kit/feedback-kit.test.mjs tools/feedback-form-gate.test.mjs tools/feedback-zero-sweep.test.mjs`\\n  → **tests 68 / pass 68 / fail 0**\\n- 両 JSON の parse 検証 OK\\n- `feedback-zero-sweep.mjs` は `repo = env[refs.repo] || repoMap[appName]` でフォールバックし、\\n  `appDir` 未設定 PC では `deferred` になるだけで落ちない（＝監視対象の追加であって誤警報源ではない）\\n\\n## 注意（マージ手順）\\n\\nこのPRは fork（`cr568`）からのもの。`.github/workflows/auto-merge.yml` は\\n`head.repo.full_name == GITHUB_REPOSITORY` を要求するため **automerge ラベルではマージされない**。\\n`squash and merge` の1クリックが必要（他に必須チェック・必須レビューは無い）。\\n\\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\",\"title\":\"feat(feedback): 倉庫アプリを不具合・要望フォームの台帳と zero 監視に登録\",\"url\":\"https://github.com/kimkon1011/orgiast-claude-rules/pull/763\"}\n",
  "stderr": ""
}
```

### downloads

```json
{
  "operation": "Downloads 直下のディレクトリ名に「倉庫」を含むものを列挙",
  "matches": [],
  "remote_check": "対象なし"
}
```

追加のローカル検索証拠: `.wt/warehouse-repo-evidence-20261027/local-projects.json` および `local-repo-references.json`。
