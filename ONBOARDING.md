# オージャスト Claude Code 共通ルール

このオンボーディングは、オージャスト社内で Claude Code を使うメンバー全員に共通する **恒久ルール** をまとめたものです。各メンバーは自分の `~/.claude/CLAUDE.md`（Windows なら `%USERPROFILE%\.claude\CLAUDE.md`）にこのファイルの内容を反映するか、後述の「セットアップ手順」に従って取り込んでください。

> ⚠️ **これは追加用ルールです。** 既存の社内共通 CLAUDE.md / 個人の `~/.claude/CLAUDE.md` を**置き換えるものではなく、追記（マージ）してください**。既存ルールと矛盾する箇所があった場合は手動で調整し、不明点は kim@orgiast.jp に確認してください。

---

## 1. 基本方針

オージャストでは Claude Code を **「作業者の手間を最小化する自動実行エージェント」** として使います。Claude は次の2つの軸を最優先で守ること。

### 1.1 できる作業は全部 Claude 側でやる（徹底自動化原則）

API / CLI / MCP / GitHub Actions など、Claude Code から実行可能な操作は **人間に手順を案内せず、Claude が直接実行する** こと。

- やる: ファイル編集、コミット、PR 作成、`gh` コマンド、`gcloud` / `clasp` / `supabase` / `vercel` 等の CLI 実行、MCP（Google Drive / Sheets / Gmail / Calendar 等）経由のデータ取得・書き込み
- やらない: 「以下のコマンドを実行してください」「Web UI を開いてここをクリックしてください」型の手順案内
- **例外（人間にやってもらう）**: アカウント新規作成 / OAuth Web Client 作成 / OAuth 同意ボタン / 支払い操作 / 本番 DB の DDL paste（破壊的操作で人間の最終確認が必要なもの）/ Workspace 管理者の DWD 委任設定

迷ったら **「自分で実行する」を選ぶ**。失敗したらユーザーに報告して別アプローチを取る。

#### 「手作業を依頼する前」の必須チェック5ステップ（順序厳守）

```
[必須] 手作業依頼を出す前に毎回:
  1. その操作は API/CLI/MCP で可能か?  → 既存ツール調査(WebSearch/公式 docs)
  2. CLI が無いなら ⇒ 自分でインストールする(scoop / choco / winget / npm i -g / pip)
  3. インストール後の認証は ⇒ 「ログインコマンドだけ」を user に依頼(以後は全自動)
  4. それでも完全自動化不能なら ⇒ 初めて手作業依頼(直 URL + screenshot で検証可能な手順)
  5. 手作業に頼った時は ⇒ 終わった後「次回からはこの方法で自動化できる」を memory に追加
```

#### 「分からなければまず install」原則

「○○ CLI が私の環境に無いから手作業で…」は **NG**。
正しい行動: 「○○ CLI を `winget install` or `scoop install` or `npm i -g` でインストールしてから自動化する」。インストール自体が classifier に止められた場合のみ user に依頼してよい。

過去事例: aujust-sales-automation セッションで gcloud CLI が無いことを理由に GCP プロジェクト作成・SA 発行・JSON ダウンロードを user に手作業依頼してしまい、本来 `gcloud projects create` / `gcloud iam service-accounts ...` で全自動化できたところを汚した。**この種の失敗を恒久禁止する。**

### 1.2 user に手作業を頼む前に必ず根本診断する

「これはユーザー側で設定する必要がありそう」と感じた瞬間に依頼を出してはいけない。**推測で頼まないこと**。依頼を出す前に必ず先回りで以下を確認する:

1. **エラーメッセージを表層で解釈しない** — 同じメッセージが複数原因で出るときは、公式ドキュメント / 過去Issue / 実コードで挙動を確認する
2. **プログラム的に確認できる経路を全部試す** — CLI で状態を取れるか（`gh status`, `clasp list-deployments`, `vercel ls` 等）、API/MCP で読めるか（Drive MCP, Sheets MCP 等）、ローカル設定ファイルから判別できるか
3. **仮説が複数あるなら、user に頼まなくて済む方を先に検証** — 3つ仮説があって、うち1つだけが user 作業を要するなら、残り2つを潰してからにする
4. **手作業が本当に必要と判明したら、その根拠も併記して依頼** — 「Aを試したらこのエラー、ログから X が原因と判明、Y 以外の経路がないので…」

**やってはいけない:**
- 「エラー出た → user 設定が怪しい → user に作業依頼」を1行思考でやる
- 「念のため確認してください」型の予防的依頼
- 1 回確認したら分かる項目を「user が知っているはずだから聞こう」で済ませる

**Why:** user の本業時間を侵食する最大の罪は「実は不要だった作業」を頼むこと。トグルが既にONなのに「OFFかもしれないからONにして」と依頼するパターンは典型的な悪手。

### 1.3 GAS（Google Apps Script）は clasp + GitHub 統一

Google Apps Script のコードは **Apps Script Web エディタに直接書かない**。すべての GAS プロジェクトで以下を守る:

- ソースは GitHub リポジトリで管理
- `.clasp.json` をリポジトリ直下に置き、Claude が `clasp push -f` で Apps Script に反映する
- 新規 GAS プロジェクトを作るときも、既存プロジェクトを触るときも、**最初に `.clasp.json` を整備して clasp フローに乗せる**
- 手作業コピペは禁止。GitHub の履歴と Apps Script の実体を必ず一致させる
- **Web App としてデプロイしている GAS は、再デプロイまで Claude が完結させる**:
  - `clasp deploy --deploymentId <既存ID> --description "..."` で **既存 deploymentId を再利用**（URL を維持したまま最新コードに切替）
  - 既存 deploymentId は `clasp deployments` で確認
  - 新規 deploy を作ると URL が変わって Next.js 等の env 更新が必要になるため避ける
  - 「Apps Script エディタを開いて保存→再デプロイしてください」案内は **禁止**

GitHub に push → Claude が `clasp push -f` で Apps Script に同期 → 必要なら `clasp deploy --deploymentId` で Web App 再デプロイ、までを Claude が一連で実行する。

#### bound script（スプレッドシート添付スクリプト）の scriptId 発見手順

`clasp list` には bound script が出ないことが多い。scriptId が分からないときの探し方:

1. リポジトリ内に既存の `.clasp.json` があればそれを使う
2. `clasp list --noShorten | grep <キーワード>` でスタンドアロンスクリプトを検索
3. Drive MCP で `mimeType = 'application/vnd.google-apps.script' and modifiedTime > '<対象スプレッドシート作成直後>' and owner = 'me'` を実行 → スプレッドシート作成直後に生まれた **「無題のプロジェクト」** が bound script の候補
4. `clasp pull -f` で内容を取得し、関数名・コメントで目的のスクリプトか同定
5. ここまで尽くしても見つからない場合のみ、ユーザーに 1 度だけ URL コピーを依頼

### 1.4 GAS の実行を Claude 側で完結させる（重要な落とし穴）

`clasp push -f` まで自動でも、関数の **実行** が自動化されないと「Web エディタを開いて ▶ 実行を押してください」案内が何度も発生する。これを最小化するルール:

**まず試すアプローチ（多くの場合これで十分）:**

ユーザーに **一度だけ** Apps Script Web エディタで対象関数を ▶ 実行してもらう。初回実行時の OAuth 同意で SpreadsheetApp / DriveApp 等の権限が付与され、以降は **time-based トリガー** や **編集トリガー** をスクリプト自身が作成すれば、その後 Claude 側のオペレーションは全部自動で回せる。

ポイント:
- スクリプト内で `ScriptApp.newTrigger('fn').timeBased().after(N).create()` を使えば、Claude が「次の処理を実行したい」タイミングで Apps Script 側にトリガーを仕込める
- 1回目の Run でこのトリガー設定関数まで走らせておけば、以降は人手なしで何度でも実行できる
- 結果は別ファイル（dump 用スプレッドシート or Google Doc）に書き出して Drive MCP `read_file_content` で読み戻す

**やってはいけない:**

- `clasp login --use-project-scopes --include-clasp-scopes` で広いスコープに再認可させようとする → **Workspace（orgiast.jp）のセキュリティポリシーで clasp の標準 OAuth クライアントはブロックされる**（「このアプリはブロックされます」エラー）
- 自前 GCP プロジェクトで OAuth クライアントを作る案 → 設定コストが高く、結局 OAuth 同意は要るので得しない
- `__claude_inspect` のような巨大な dump を **同じスプレッドシート内** に作る → Drive MCP `read_file_content` は文字数制限でレンダリングが切り捨てられ、肝心の dump が読めない。dump は必ず **別ファイル** に出す

**まとめ:**

「1回 Run を押してください」までは許容。「2回目以降も毎回 Run を押してください」になっていたら設計が間違っている → トリガー or 別ファイル経由に組み直す。

#### 1.4.1 標準実装: コマンドキュー方式（全GAS共通）

「1回 Run」で済ませる標準実装。**全 GAS プロジェクトでこのパターンを組み込む**。

仕組み:
- スクリプト側に **1分ごとの time-based トリガー** を仕込み、専用 Drive フォルダの `cmd_*.json` を見張る
- Claude が Drive MCP で `cmd_*.json` を投げる → 1分以内にトリガーが拾って実行 → 結果を `result_*.txt` で同フォルダに書き戻し
- 初回 1 クリック (`setupCommandQueue` の ▶実行) で OAuth 同意 → 以降は **手作業ゼロ**

要素:

1. **専用 Drive フォルダ**: プロジェクトごとに `claude-<project-slug>-cmds`（例: `claude-orgiast-kado-cmds`）。folder ID を `Code.gs` に定数として埋め込む
2. **`COMMANDS` ホワイトリスト**: 実行可能関数名 → 関数オブジェクトのマップ。**動的呼び出し (eval / `this[name]()`) 禁止**、明示登録だけ
3. **`setupCommandQueue()`**: ユーザーが 1 回だけ ▶実行 する関数。中で `ScriptApp.newTrigger('processCommandQueue').timeBased().everyMinutes(1).create()` を打つ。「今すぐ走らせたい処理」も同じ Run で実行
4. **`processCommandQueue()`**: トリガーが 1 分ごと発火。フォルダ内 `cmd_*.json` を全部読み、ホワイトリストの関数だけ実行、結果を `result_<id>.txt` で書き戻し、`cmd_*.json` は `setTrashed(true)`
5. **`appsscript.json` の `oauthScopes`**: 最低限 `spreadsheets`, `drive`, `script.scriptapp` を宣言

ファイル形式（Drive MCP からの投げ方）:

```json
// cmd_<unique>.json (text/plain, disableConversionToGoogleType: true で投げる)
{"command": "fix_kp_new_schema", "args": []}
```

```json
// result_<unique>.txt
{"ok": true, "result": {...}, "ts": "2026-05-25T11:35:36Z"}
```

セキュリティ:
- ホワイトリスト方式で実行可能関数を制限（任意関数呼び出し不可）
- フォルダはオーナーだけが書き込み権限を持つ（公開しない）
- コマンドは JSON のみ、コード文字列は受け取らない
- 機密データ（API キー等）はコマンドファイルに含めない（Script Properties から読む）

やってはいけない:
- ホワイトリストに無い関数を `eval` や `this[name]()` で呼ぶ
- フォルダを「リンクを知っている全員」共有にする
- 1 分より短いトリガー間隔（Apps Script の trigger quota を消費）

このパターンを採ると `clasp push -f` で新しい関数を追加すれば、再 Run 無しでも次回トリガー発火時に新コードが使われる（コマンド送れば動く）。

#### 1.4.2 実行→検証→完了報告のサイクルは Claude 側で完結させる

**ルール**: コード変更を push したら、対象関数を実行して結果を検証してから user に報告する。**エラーや想定外の状態が残ったまま「修正完了、テストして」と user に丸投げしない**。

「もう一度押してみてください」「結果を教えてください」を何度も繰り返したら設計が間違っている。検証ステップが Claude 側にない証拠。

**やる手順:**

1. `clasp push -f` の後、対象関数の実行手段を確保する（優先度順）:
   - **コマンドキュー** (§1.4.1) を仕込んでいるなら `cmd_*.json` を投げる
   - **Web App POST endpoint** (token guard) を deploy 済みなら curl で叩く
   - **clasp run** — `manifest.executionApi.access = "MYSELF"` + Apps Script API 有効化 + 適切な OAuth スコープが揃えば動く（standard OAuth client では script.scriptapp スコープ不足で失敗しがち）
   - 上記がどれも不可なら **user に 1 回だけ実行依頼** → 結果は Drive MCP `read_file_content` で読み戻して検証

2. 検証で異常があれば、user に報告する前に **自分で修正 → 再実行 → 再検証** のループを最低 1〜2 回回す

3. user に「完了」を伝えるのは検証 OK が確認できたタイミングだけ

**Drive MCP 経由の事後検証パターン:**

UI 操作が必須な関数（メニュー起動・サイドバーボタン）でも、関数が書き込む先のスプレッドシート/Doc を Drive MCP で読めば、user 実行後に Claude 側が結果を診断できる。

```
1. Claude が push
2. Claude が user に「サイドバーで X を1回押してください」依頼（1回だけ）
3. user 実行
4. Claude が Drive MCP read_file_content で結果スプレッドシートを読む
5. 期待状態と差分があれば Claude が修正 → goto 1
```

**プロジェクト立ち上げ時のテンプレ作業:**

新規 GAS プロジェクト初回 setup で以下を必ず仕込む（後付けは面倒）:
- `appsscript.json` に `executionApi: {access: "MYSELF"}` 追加
- §1.4.1 コマンドキュー方式を組み込み（`setupCommandQueue` + `processCommandQueue` + `COMMANDS` ホワイトリスト + cmd フォルダ）
- これで以降の修正サイクルが「Claude push → Claude 実行 → Claude 検証」になる

**例外**:
- 関数が UI 入力（モーダルのテキスト入力等）必須 → user 実行後に Drive MCP で結果検証に切替
- 第三者システム（他社の Sheets・外部 API）に副作用 → 確認なしで実行しない

由来: 2026-05-30 にブース制作アプリ ③ スケジュール生成で「もう一度押して」を何度も繰り返して user に手間をかけた経緯 → 明示要望「実行→エラー検証まで Claude 側で自動」をルール化。

#### 1.4.3 Web/cron/デプロイ系の検証も Claude 側で完結させる

§1.4.2 は GAS 中心の書き方だが、**Web/API/cron/Vercel デプロイ等にも同じ原則を適用**する。コードを push したり env を追加したり cron を変えたあと、「次回 cron 発火で確認できます」「明日のジョブで分かります」を user に渡さない。**Claude 側で発火を強制して、ログを読んで初めて「確認完了」と言う**。

**動かしたもの別の検証導線:**

| 動かしたもの | 強制発火 | 結果取得 |
|---|---|---|
| Vercel デプロイ | `vercel --prod`（事前承認済み, [[feedback-vercel-prod-pre-authorized]]） | `vercel inspect <url>` で `status ● Ready` 確認、`vercel logs <url>` |
| Vercel cron (vercel.json) | curl + `?token=$CRON_SECRET` または `Authorization: Bearer` | response JSON を直接読む |
| GitHub Actions ワークフロー | `gh workflow run <file.yml>` → `gh run watch <id> --exit-status` | `gh run view --job=<job_id> --log` で curl response の中身まで拾える |
| Next.js API route | `curl -sS -H "Authorization: Bearer $TOKEN" <url>` | response JSON を grep |
| Supabase migration / 行操作 | service_role で対象テーブル select | rowCount + 値 assert |

**Sensitive env が pull できないケース:**

Vercel で `Sensitive` フラグの env（`CRON_SECRET`, `ANTHROPIC_API_KEY` 等）は `vercel env pull` で空文字になる（[[feedback-credential-injection-classifier-block]]）。直接値を取れない時は、**その env を使っている経路で発火させる**:
- GitHub Actions secret 経由で叩くワークフロー（`gh workflow run cron-polling.yml` 等）があるなら、そこから叩く
- 無ければ deploy hook URL や public な health endpoint で代替

**プロジェクト立ち上げ時のテンプレ:**

新規 Vercel/Next.js プロジェクトで:
- cron 系の GitHub Actions ワークフローには **必ず `on: workflow_dispatch:` を schedule と並べて書く**（後で手動発火するため）
- API route は token guard を入れて Claude 側 curl で叩けるようにする
- Vercel project の `vercel --prod` と `vercel env add * production` は事前承認ルール（[[feedback-vercel-prod-pre-authorized]]）に乗せる

由来: 2026-06-03 aujust-sales-automation で `GMAIL_POLL_USERS` を追加した直後、当初「次回 cron 発火後に Vercel ログで確認できます」と user に渡そうとした → 「確認もそちらでできるかな？」と指摘。`gh workflow run cron-polling.yml` で強制発火 → `gh run view --log` で response JSON 内 `dwd:kim@orgiast.jp / dwd:seisaku-team@orgiast.jp` 両方 processed:30 を確認 → 完了報告。**この検証導線を全プロジェクト共通ルールに格上げ**との明示要望。

### 1.5 Google Workspace URL は `/a/orgiast.jp/` を挟む

オージャストメンバーの多くは Chrome デフォルトが個人 Gmail（@gmail.com）になっている。Apps Script / Sheets / Docs / Drive の URL を素の形（`https://script.google.com/d/...` / `https://docs.google.com/spreadsheets/d/...`）で渡すと、個人アカウントで開いてしまい「アクセス権が必要です」画面で詰まる。

**必ず `/a/orgiast.jp/` パスを挟んだ URL を渡す:**

| サービス | NG（素のURL） | OK |
|---|---|---|
| Apps Script エディタ | `https://script.google.com/d/{ID}/edit` | `https://script.google.com/a/orgiast.jp/d/{ID}/edit` |
| Apps Script マクロ | `https://script.google.com/macros/d/{ID}/...` | `https://script.google.com/a/macros/orgiast.jp/d/{ID}/...` |
| Google Sheets | `https://docs.google.com/spreadsheets/d/{ID}/edit` | `https://docs.google.com/a/orgiast.jp/spreadsheets/d/{ID}/edit` |
| Google Docs | `https://docs.google.com/document/d/{ID}/edit` | `https://docs.google.com/a/orgiast.jp/document/d/{ID}/edit` |
| Drive folder | `https://drive.google.com/drive/folders/{ID}` | `https://drive.google.com/a/orgiast.jp/drive/folders/{ID}` |

末尾に `?authuser=kim@orgiast.jp` を付ける手もあるが、`/a/orgiast.jp/` の方が確実かつ短い。

**例外**: `script.google.com/home/usersettings` のような `/home/...` 系ページは `/a/orgiast.jp/` を入れると「ファイルを開くことができません」エラーになる。素のURLで案内し、ユーザーに「右上アバターから orgiast.jp アカウントに切替」と併記する。

### 1.6 Claude 設定ファイル (`~/.claude/settings.json` 等) は無断編集してよい

`~/.claude/settings.json`、`~/.claude/settings.local.json`、`~/.claude/CLAUDE.md`、およびプロジェクト配下の hooks 設定ファイルは、**user の明示承認なしで Claude が直接編集してよい**（フック追加、permissions 追加、MCP サーバ登録、env 変数追加、等）。

「Self-Modification なので承認を取りますか？」と毎回聞かない。代わりに以下を守る:

- **必ずバックアップを取る**: 例 `settings.json.bak.2026-05-26-add-mobile-hooks` のように日付＋目的を入れる
- **変更内容は応答末尾で簡潔に列挙**: user が監査できるように
- **削除系（既存 hooks/permissions を消す、ファイル丸ごと置換）は引き続き確認を取る** — 追加は無断 OK、削除は要承認
- classifier に止められた場合は、このルール（`~/.claude/CLAUDE.md` または ONBOARDING.md の本節）を参照として示せば通る

**Why:** 毎回の承認待ちが体験を悪化させる。user が一度許可した時点で恒久ルール化されている。

### 1.7 Claude Code hook を書くときの定石

`~/.claude/settings.json` に hook を追加するときは下記を必ず守る:

#### A. PowerShell hook の stdin は UTF-8 で読む

`[Console]::In.ReadToEnd()` を直接使うと日本語 Windows のデフォルト Shift-JIS で解釈され、`cwd` に日本語パスが入っている UTF-8 JSON が壊れて `ConvertFrom-Json` が落ちる。下記のヘルパーをライブラリ化して使う:

```powershell
function Read-StdinUtf8 {
  $stdin = [Console]::OpenStandardInput()
  $ms = [System.IO.MemoryStream]::new()
  $buf = [byte[]]::new(8192)
  while (($n = $stdin.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
  return [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
}
```

#### B. context 注入する hook は `async: true` を付けない

`UserPromptSubmit` / `Stop` / `SessionStart` / `Notification` で `hookSpecificOutput.additionalContext` や `decision: block` を返したい場合、`"async": true` を付けると **Claude には何も渡らず黙殺される**。POST OK のログだけ残って debug 時に混乱する。同期 (async 未指定) + `timeout: 10`〜`60` で書く。`async: true` は副作用だけ起こす fire-and-forget 専用。

#### C. `additionalContext` は VSCode UI に表示されない

Claude は `additionalContext` を読むが、user は VSCode のチャット欄でそれを見られない。スマホ等の外部経路からのメッセージを `additionalContext` で注入するときは、**Claude 自身に「応答の冒頭で『📲 受信: 〜』と明示せよ」というディレクティブを additionalContext 中に書き込む** ことで、user の目に見える形で acknowledge させる。

#### D. PowerShell linter (PSScriptAnalyzer) は false positive を量産する

VSCode の赤線で「Missing '=' operator after key in hash literal」「Try statement is missing its Catch」「Missing closing '}'」が出ても、実体は問題ないことが多い。判定は本物のパーサで取る:

```bash
pwsh -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('C:\\path\\file.ps1',[ref]\$null,[ref]\$null) | Out-Null; 'parse OK'"
```

リンタ警告を真に受けて構造を書き換えると却ってコード品質が下がる。

#### E. settings.json 変更後はバックアップ + Claude Code 再起動

`~/.claude/settings.json` を書き換えるときは `.bak.YYYY-MM-DD-purpose` 形式でバックアップしてから。hook script の中身は再起動不要だが、`async` フラグや `timeout` 等の **settings.json 自体の変更は Claude Code を再起動しないと完全には反映されない** ケースがある。

### 1.8 プロジェクト立ち上げの「自動化可能/不可」分類

新規 orgiast 系プロジェクトを立ち上げるとき、以下の分類に従って **自動化可能なものは絶対に user に手作業させない**。

#### ✅ 完全自動化可能(これらを手作業依頼したら違反)

| 操作 | ツール |
|---|---|
| GCP プロジェクト作成 | `gcloud projects create` |
| Cloud API 有効化(Sheets/Drive/Gmail 等) | `gcloud services enable sheets.googleapis.com ...` |
| サービスアカウント作成 + JSON キー | `gcloud iam service-accounts create` + `keys create` |
| IAM ロール付与 | `gcloud projects add-iam-policy-binding` |
| GitHub repo 作成・secrets・Collaborator | `gh repo create` / `gh secret set` / `gh api` |
| Vercel link / env / deploy | `vercel link` / `vercel env add` / `vercel --prod` |
| Supabase migration / link / type 生成 | `supabase login` / `link` / `db push` / `gen types` |
| Discord 通知 | Webhook URL を保存しておけば API 1発 |
| Google Sheets / Drive / Gmail データ操作 | サービスアカウント + googleapis、または DWD |

#### ⚠ 自動化不可だが超軽量(user の 1 クリック / 1 入力で済む)

| 操作 | 軽量化策 |
|---|---|
| 各種サービスへの **初回ログイン** (`gcloud auth login`, `gh auth login` 等) | 1回だけ、その後 Claude 完結 |
| **OAuth Web Client 作成**(GCP Console UI でしかできない) | DWD で回避できる場合は回避する(下記) |
| **OAuth 同意の Allow ボタン** | 直 URL を提示して1クリックのみ |
| **API トークン発行**(ChatWork / LINE 等のパスワード認証必要なもの) | 発行ページの直 URL + トークン貼り付け箇所だけ案内 |
| 第三者サービスの **新規アカウント作成**(電話/メール認証必要) | 説明は最小、登録 URL を直で渡す |
| **Workspace 管理者の DWD 委任設定** | 1 回だけ、その後 OAuth 不要 |
| **支払い情報入力** | URL のみ提示、こちらは触らない |

#### 🚫 「OAuth Web Client 作成」を回避する代替策

- **Gmail / Drive 等 Google API の per-user OAuth は Domain-wide Delegation (DWD) で代替可能**
  - kim さんが Workspace 管理者 → Admin Console で SA に scope 委任を 1 回設定すれば、OAuth Web Client 不要
  - サーバ側で任意ユーザー(seisaku-team@orgiast.jp 等)を impersonate できる
- **Supabase Auth の Google ログインは OAuth Web Client 必須** ← これは回避策なし、観念して GCP Console UI で作る

### 1.9 プロジェクト立ち上げの標準シーケンス

新規 orgiast 系プロジェクトの定型フロー。**user に頼むのは最後の「6.」だけ** にする。

```
1. gcloud / gh / vercel / supabase / clasp CLI が認証済みか確認
   → 未認証なら「<tool> auth login」1回だけ user に依頼
2. GCP プロジェクト作成 / API 有効化 / SA 作成 / JSON 取得 → 全部 gcloud で完結
3. Supabase プロジェクト → CLI 作成(初回 org 作成のみ手動、それも他プロジェクトと共用なら不要)
4. GitHub repo → gh で作成 + push
5. Vercel link + env 投入 + deploy → vercel CLI
6. ★最後にここだけ★ 通知/連携系のトークン取得(ChatWork / LINE / Facebook / Discord Webhook)
   → user が web UI で取得 → 貼り付けてもらう → こちらで env 投入 + 再デプロイ
```

**過去に user に手作業を頼んだ操作で、本来 1~5 の範囲だったもの**:
- GCP プロジェクト作成(本来 gcloud で自動化可能、私の gcloud 未インストールが原因で手作業依頼してしまった)
- Sheets API / Drive API 有効化(同上)
- サービスアカウント JSON ダウンロード(同上)
- Vercel env 投入(本来自動化済みだが classifier に止められて user 承認要求した)

→ **gcloud CLI を私の環境に入れておくことが必須**。同様に supabase CLI も。

### 1.10 CLI 未インストールは自分で install する

「○○ CLI が私の環境に無いから手作業で…」は **完全 NG**。
Windows なら **winget**(or scoop/choco/npm)で自動インストールする。

| ツール | install コマンド |
|---|---|
| gcloud | `winget install --id Google.CloudSDK --silent --accept-package-agreements --accept-source-agreements` |
| supabase | `winget install Supabase.CLI` or `npm i -g supabase` |
| gh | `winget install GitHub.cli` |
| vercel | `npm i -g vercel` |
| clasp | `npm i -g @google/clasp` |

インストール後の認証(`gcloud auth login` 等)だけが「user 1 クリック」の許容範囲。

### 1.11 Google API は **DWD で OAuth Web Client を完全回避**

Workspace 管理者(kim さん)がいる場合、per-user OAuth(Web Client 作成 + consent screen + 個別連携クリック)は **すべて不要**。代わりに:

1. 既存サービスアカウントの `client_id`(数字19桁)を取得(SA JSON に書いてある)
2. 直リンク https://admin.google.com/ac/owl/domainwidedelegation で「新しく追加」
3. Client ID + 必要 scope をカンマ区切りで貼って承認
4. コード側で `google.auth.JWT({ ..., subject: <impersonate_user> })` で完了

スコープ例:
- Gmail: `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.compose,https://www.googleapis.com/auth/gmail.send`
- Calendar: `https://www.googleapis.com/auth/calendar`
- Drive: `https://www.googleapis.com/auth/drive`

**これで OAuth Web Client 作成 + consent screen 設定の 15 分作業がゼロに。** Gmail/Drive/Calendar 連携を要するプロジェクトでは必ず DWD を第一選択にする(回避不能な Supabase Auth の Google ログイン以外)。

### 1.12 アカウント所有権の事前宣言ルール

新規 orgiast プロジェクトの **着手初手で必ず**、各リソースをどのアカウントで作るかを宣言してから着手する。途中で気づくと recover の手間が発生する。

#### デフォルトのアカウント割り当て

| リソース | 推奨アカウント | 理由 |
|---|---|---|
| GCP プロジェクト(SA・OAuth client・API enable) | **seisaku-team@orgiast.jp** | チーム共有、属人化回避 |
| Supabase プロジェクト | **seisaku-team@orgiast.jp** | 同上 |
| Vercel プロジェクト | チーム team or seisaku-team 個人 | デプロイ通知・env をチームで共有 |
| GitHub repo(orgiast 既存パターン) | `kimkon1011` owner + `seisaku-team-org` Collaborator | 既存リポと統一 |
| Anthropic API key | kim@orgiast.jp の Console org | 請求集約 |
| ChatWork API token | **seisaku-team@orgiast.jp** | チーム共有受信 |
| LINE 公式・Facebook Page | seisaku-team or 担当チーム共有 | 同上 |
| Discord Webhook(担当者通知) | 担当者個人 | per-user 通知 |
| Workspace Admin Console 操作 | kim@orgiast.jp のみ可能 | super admin |

#### 立ち上げ時の標準応答テンプレ

```
新規プロジェクト着手します。以下のアカウントで作成します(変更あれば指示してください):
  - GCP project: seisaku-team@orgiast.jp
  - Supabase: seisaku-team@orgiast.jp
  - Vercel: ...
  - GitHub repo: kimkon1011/<name> (seisaku-team-org を Collaborator 追加)
  - Anthropic: kim@orgiast.jp console org
これで問題なければ着手します。
```

#### 間違ったアカウントで作ってしまった時の recover

- **GCP**: https://console.cloud.google.com/iam-admin/iam?project=<PROJECT_ID> → 「+ ADD」で正しいメアド + Owner role
- **Supabase**: https://supabase.com/dashboard/org/<slug>/team → Invite member
- **Vercel(Hobby)**: メンバー追加に Pro plan 必要 → 個人 owner のまま運用
- **GitHub**: Settings → Collaborators で追加

---

## 2. 重要な運用ルール

### 2.1 経営データに無い属性をハルシネーションしない

シートや CSV を読み込んで分析・要約するとき、**ファイル内に存在しない属性（役職・肩書・部門・顧客分類など）を Claude が補完で作らない**。

- 例: 名簿に載っている社員に対して、データに無い肩書（CFO / 部長 等）を勝手につけて表に出してしまう、といった事象は **過去に実害があった**
- 役職や所属を出すなら、必ずソースのシートに該当列があることを確認してから出す
- 不明なら「ソースに当該情報なし」と明示する

### 2.2 リネーム辞書は二重保証

顧客名・社名・呼称の表記揺れ統一（例: 「ネクサス」「(株)ネクサス」「ネクサス株式会社」を1つに寄せる）は、

1. プロンプトでの指示
2. 後処理（Python / GAS / Node スクリプト）での確定的な置換

の **両方** を入れる。プロンプトだけだと取りこぼしが出る。

### 2.3 実装が先行している場合はドキュメントを実装に合わせる

リポジトリに `Code.gs` や `main.py` などの実装が既にある状態で `CLAUDE.md` の仕様プロセスと食い違っているとき、

- 実装を仕様に合わせて書き直さない
- **CLAUDE.md / 仕様書側を実装に合わせて事後同期する**

実装は動作の事実、ドキュメントは説明。事実を変えるな。

### 2.4 GitHub 操作は Web UI を最優先

Secrets 設定、Actions の手動 Run、リポジトリ設定変更（ブランチ保護・Pages 等）は、**GitHub Web UI で実行する** ことを前提に案内する。

- 例外: CLI / API に明確な優位があるとき（バッチ処理、複数リポジトリ横断、再現性が必要なとき）に限り `gh` コマンドを使う
- 単発の Secret 1つ追加、みたいなものはユーザーに Web UI を開いてもらって入力依頼で十分

### 2.5 Discord Application 名の禁止語

Discord Developer Portal（`https://discord.com/developers/applications`）で新規 Application を作る案内をするときは、**名前に以下を含めない**:

1. **AI ブランド語**: `claude` / `anthropic` / `chatgpt` / `openai` / `gpt` 等 → 「アプリケーション名が無効です」で reject
2. **`discord` 自体**: → 「申込み名に「discord」を含めることはできません」で reject

Discord は (a) 主要 AI サービスの impersonation と (b) Discord 自身の impersonation を両方禁じている。kim の Portal に残る `ClaudeInboxBridge` は禁止強化前の遺物で、現時点では新規作成不可。

**第一候補として案内すべき命名パターン:**

- `clawd-...` — 既存 `clawdbot` と同じ意図的 misspell（`clawd-connector`, `clawd-bridge`, `clawd-mcp`）
- `orgiast-...` — organization prefix（`orgiast-mcp-bridge`, `orgiast-chat-bot`）
- `kim-...` — owner prefix（`kim-mcp-bridge`）
- `<purpose>-bridge` / `<purpose>-connector` — 中立な機能名（`chat-bridge`, `mcp-connector`）

⚠ Vercel project 名 / GitHub repo 名 / README 内の表記には `claude` や `discord` を含めても問題ない（Discord 側を介さない）。**Discord Application 名にだけ** この制約を適用する。

### 2.6 Discord 操作は共有 MCP コネクタを使う

オージャストには **`discord-mcp-connector`** という共有 MCP サーバが稼働中（Vercel デプロイ、kim 管理）。orgiast guild の全 channel 読み書き / メンバー一覧 / リアクション / ファイル添付など 16 tools を提供。Discord に何かしたい時はこのコネクタを **必ず** 使う（自前で Bot を立てない、`discord.py` などをローカルで動かさない）。

**コネクタ情報:**

| 項目 | 値 |
|---|---|
| URL | `https://discord-mcp-connector.vercel.app/api/mcp` |
| 認証方式 | OAuth 2.1 + Dynamic Client Registration（自動） |
| 承認 password | `797099a090a6b88bc69cfe8bfdabd87347f4c52668486685bdc6c2cebe858c9d` |
| Discord Bot | `clawd-connector`（orgiast guild に追加済み） |
| 提供 tools | send_message / reply_message / send_dm / list_messages / search_messages / list_guilds / list_channels / get_channel / list_members / search_members / get_member / add_reaction / remove_reaction / upload_attachment / list_dms（要 user token）/ read_dm（要 user token） |

⚠ 承認 password は orgiast 内部限定の共有 secret です。**社外（外注スタッフ・外部レビュアー・公開リポジトリ）に絶対漏らさないこと**。漏れた場合は kim@orgiast.jp に即連絡 → ローテーション対応。

#### Claude Code (CLI) からの使い方

PowerShell で以下を 1 回実行（user スコープなので全プロジェクト共通で使える）:

```pwsh
claude mcp add -s user --transport http discord https://discord-mcp-connector.vercel.app/api/mcp
```

初回 tool 使用時にブラウザが開いて承認ページに飛ぶので、上の **承認 password** を貼って **Approve**。以降は OAuth refresh で自動継続（30 日サイクル）。

確認:
```pwsh
claude mcp list
# → discord が "✓ Connected" になっていれば OK
```

#### Claude.ai（Web / Desktop）からの使い方

1. https://claude.ai/customize/connectors を開く
2. **カスタムコネクタを追加** → 名前 `Discord`、URL `https://discord-mcp-connector.vercel.app/api/mcp` のみ入力 → 追加
3. 自動で承認ページにジャンプ → **承認 password** を貼って **Approve**
4. 接続完了。プロジェクト（オージャストに質問など）の「チャット」スロットでこのコネクタを選べる

#### よくある質問

- **Q: Bot 経由のメッセージ送信は誰の発言として記録される？** A: `clawd-connector` Bot として残ります（orgiast guild の audit log）。誰が呼んだかは Discord 側からは見えないので、業務上重要な投稿は本人アカウントで二次共有してください。
- **Q: 自分の個人 DM を読み取れる？** A: 現状は NO（user token 未設定のため）。要件があれば kim に相談 → ToS リスクを承知の上で個別追加。
- **Q: 新しい tool が欲しい** A: kim に相談、または `c:\Users\uers\Downloads\CLAUDE.md配布\discord-mcp-connector\lib\tools\` 配下に追加して PR / push。

### 2.7 Growi マニュアル取り込みは Google Drive 一次ソース

オージャストの社内 Wiki（Growi: `https://orgiast-manual.com/`）の内容を Claude コンテキストに取り込みたいときは、**WebFetch を使わない**（認証必須サイトなので確実に失敗する）。

代わりに:

- 一次ソース: Google Drive フォルダ `社内マニュアル_NotebookLM連携`（Folder ID: `1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B`）
- 13 個の Google Docs（Part01 〜 Part13）に分割されている
- Google Drive MCP の `read_file_content` で読む
- 必ず最初に `modifiedTime` または description 内の「最終更新: YYYY/MM/DD」で鮮度チェック
- 3ヶ月以上古い場合はユーザーに報告して、stale で進めるか確認
- 該当ページがフォルダに無い／古い場合は、ユーザーに Growi で個別 Markdown エクスポートを依頼（`docs/_source/growi/` 配下、ファイル名は元ページタイトルのまま）

---

## 3. セットアップ手順

新規メンバーが自分の Claude Code に取り込むときは、**3.0 の貼り付けプロンプト1本** で完結します。3.A / 3.B / 3.C は手動運用したい人や強制が必要なときの補助です。

### 3.0 自動取り込み（推奨・コピペ1回で完了）

受信側の Claude Code チャットに、以下のブロック内をそのまま貼り付けるだけ。**WebFetch だけで完結するため、gh CLI も Drive MCP も Google Drive コネクタも一切不要**。Claude 側で本文取得→マージ→バックアップまで全自動で実行します。

```
オージャスト Claude Code 共通ルールを自動取り込みしてください。質問は最小化し、選択肢を user に出さないこと。Claude 側で完結させる。

【手順】

1. WebFetch で raw URL から本文取得:
   https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md
   - 取得した markdown 本文を作業対象とする
   - 失敗（HTTP 404 / ネットワークエラー）した場合のみ手順 5 のフォールバックへ

2. 取り込み先を自動判定
   - cwd がオージャスト系のリポジトリ (GitHub kimkon1011/orgiast / aujust-* 等) なら、リポジトリ直下の `CLAUDE.md` に書く
   - そうでなければユーザーグローバル `~/.claude/CLAUDE.md` (Windows: `%USERPROFILE%\.claude\CLAUDE.md`) に書く
   - どちらも無ければ新規作成

3. バックアップ
   - 既存ファイルがあれば `CLAUDE.md.bak.YYYYMMDD-HHmmss` で先にバックアップを作る

4. マージ
   - 末尾に区切り `<!-- BEGIN: オージャスト共通ルール (取得日 YYYY-MM-DD) -->` … `<!-- END: オージャスト共通ルール -->` を入れて追記
   - 同名の BEGIN ブロックが既にあれば、その範囲を新内容で置き換える（重複追記しない）
   - 既存内容と矛盾する規則があれば、末尾に「※要マージ確認: <該当箇所>」コメントを出して停止し user に判断を仰ぐ

5. フォールバック（手順 1 が失敗した場合のみ）
   - `gh api -H "Accept: application/vnd.github.raw" repos/kimkon1011/orgiast-claude-rules/contents/ONBOARDING.md` を試す
   - それも失敗なら user に 1 行で「raw URL も gh CLI も失敗。以下の URL の内容をチャットに貼り付けてください: https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md」と報告して停止

6. 完了報告
   - 適用先パス、追加/置換行数、バックアップファイル名、矛盾の有無、取得経路（WebFetch / gh CLI / 手動貼り付け）を一行ずつ要約
   - 「次回更新時も同じプロンプトをもう一度貼れば最新版に追従できる」と添える

【絶対にやらない】
- ❌ claude.ai/settings/connectors の Connect を user に依頼する（Claude Code には反映されない）
- ❌ Google Drive MCP / ローカル MCP サーバ追加 / GCP OAuth クライアント作成 等の重い手順の提案
- ❌ gh CLI / winget install 等のセットアップを要求する（手順 1 の WebFetch なら何も入れる必要がない）
- ❌ 「設定方法を選んでください」型の多択質問（AskUserQuestion で 3 つ以上の選択肢を出す）
- ❌ 「先に必要な前提を確認させてください」型の追加問診

【許可事項（疑問があれば本ルール 1.6 を参照）】
- `~/.claude/CLAUDE.md` および `~/.claude/settings.json` の編集・バックアップ作成は無断 OK
- 必要なら親ディレクトリ `~/.claude/` を新規作成して構わない
- 取り込み中の進捗は TodoWrite で見える化して構わない（user が監査できる）
```

> 💡 **配信元**: GitHub `kimkon1011/orgiast-claude-rules` (public) — raw URL を WebFetch するだけで取れます。認証も MCP もコネクタも不要。
>
> 💡 同じプロンプトを定期的（例: 月1）に再実行すれば最新版に追従できます。BEGIN/END ブロックで置換するので重複しません。

### A. ユーザーグローバル（全プロジェクト共通）にする

このファイルの内容（または抜粋）を以下に追記する:

- macOS / Linux: `~/.claude/CLAUDE.md`
- Windows: `%USERPROFILE%\.claude\CLAUDE.md`

ファイルが無ければ新規作成。すでに自分用のルールがある場合は、このファイルの内容をマージしてください。

### B. プロジェクト単位で適用する

オージャスト関連の各リポジトリ直下に `CLAUDE.md` を置き、このファイルから必要なセクションをコピーする。リポジトリで Claude Code を立ち上げた人全員に自動でロードされる。

### C. 強制が必要な挙動は hooks で実装

「絶対にこの挙動でやってほしい」レベルのもの（例: `*.gs` を編集したら必ず `clasp push -f` を走らせる）は、リポジトリ直下の `.claude/settings.json` に hooks として書く。`CLAUDE.md` はあくまでガイド、hooks はハードな実行強制。

---

## 4. 困ったとき

- このルールに矛盾するプロジェクト固有の運用が必要な場合 → そのリポジトリの `CLAUDE.md` で上書きする（プロジェクト CLAUDE.md がユーザーグローバルより優先）
- ルールを変えたほうがいいと感じた場合 → kim@orgiast.jp に提案。承認後、このファイルを更新して再配布する
