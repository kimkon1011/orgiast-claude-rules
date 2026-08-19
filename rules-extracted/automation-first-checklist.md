# 徹底自動化・手作業依頼の判断詳細

ONBOARDING.compressed.md §1.1 / §1.2 の詳細。

## 1.1 できる作業は全部 Claude 側でやる（徹底自動化原則）

API / CLI / MCP / GitHub Actions など、Claude Code から実行可能な操作は **人間に手順を案内せず、Claude が直接実行する** こと。

- やる: ファイル編集、コミット、PR 作成、`gh` コマンド、`gcloud` / `clasp` / `supabase` / `vercel` 等の CLI 実行、MCP（Google Drive / Sheets / Gmail / Calendar 等）経由のデータ取得・書き込み
- やらない: 「以下のコマンドを実行してください」「Web UI を開いてここをクリックしてください」型の手順案内
- 例外（本当に人間にしかできないもの）: アカウント新規作成 / OAuth 同意ボタン(初回のみ) / 支払い操作 / Workspace 管理者の DWD 委任設定 / 物理操作(スマホでのLINE友達追加、QRスキャン等) / 権限の無い他社リソース

## 1.1.1 直接できる作業は絶対 user に振らない(絶対ルール、2026-06-08 強化)

「DDL paste は例外」「Vercel UI クリックは例外」のような抜け道を作らない。Supabase の migration も `supabase db push --db-url '<conn>'` で自動化可能。GitHub Secret 設定も `gh secret set` で可能。Vercel env も `vercel env add` で可能。

判断ルール:
- ✅ 確認(質問・選択肢提示・状態スクショ依頼)は OK
- ❌ 作業(SQL 実行、Web UI クリック、ファイル保存、メール送信)は絶対 NG
- 認証情報が無くて自動化不能 → 「1 回だけ token/password/connection-string を貼ってください」と依頼して直ちに `.env.local` や OS keystore に永続保存 → 以降は完全自動化。毎回 paste 依頼してはいけない(初回 setup と継続作業を厳密に区別する)

過去事例(2026-06-08): aujust-sales-automation で migration 0011 を「Supabase SQL Editor で paste 実行してください」と user に依頼 → 「そちらでできないのかな」「今後直接できるものをこちらと分担しないように徹底してほしい。これは絶対ルールとしてください。確認は良いけれど、作業は絶対こちらに振らない」と明示要望 → `supabase db push --db-url` で自動化可能だったと判明。例外の抜け道を作らないルールに改訂。

迷ったら「自分で実行する」を選ぶ。失敗したらユーザーに報告して別アプローチを取る。

### 「手作業を依頼する前」の必須チェック5ステップ（順序厳守）

```
[必須] 手作業依頼を出す前に毎回:
  1. その操作は API/CLI/MCP で可能か?  → 既存ツール調査(WebSearch/公式 docs)
  2. CLI が無いなら ⇒ 自分でインストールする(scoop / choco / winget / npm i -g / pip)
  3. インストール後の認証は ⇒ 「ログインコマンドだけ」を user に依頼(以後は全自動)
  4. それでも完全自動化不能なら ⇒ 初めて手作業依頼(直 URL + screenshot で検証可能な手順)
  5. 手作業に頼った時は ⇒ 終わった後「次回からはこの方法で自動化できる」を memory に追加
```

## 1.1.3 「手渡す前に必ず自分で試す」— 特に git / PR マージ（2026-07-09 追加）

最悪の違反 = 自分で試しもせず手渡しの一文を書くこと。「PR をマージしてください」「ここをクリックしてください」と書く前に、必ず対応する CLI/API を実際に叩く。ツール(または classifier)が「できない」と返して初めて手渡し候補になる。手渡しの可否を推測で先に決めない（"最後の1ステップだけ user に" は最も陥りやすい罠）。

git / PR フローは Claude が端から端まで駆動する:
- commit → push → `gh pr create` → `gh pr merge --squash --delete-branch` まで自分でやる。「PR を作ったのでマージお願いします」で止めない。**自作 PR のマージも自分で行う**（2026-08-19 kim 決定。下記の事前条件を必ず満たすこと）。
- 直 push が classifier block でも、それは「PR 経由でやれ」の意味であって「user にやらせろ」ではない。コンフリクト解決・型チェック・検証も自分でやる。

| 操作 | 扱い | Claude の正しい対応 |
|---|---|---|
| default ブランチへの直 push | ブロックされる（PR レビュー迂回） | 自分で PR を作る |
| 自作 PR のマージ | 2026-08-19 に例外から除外 | **自分でマージする**。`gh pr merge --squash --delete-branch`。classifier に実際にブロックされた時だけ手渡す |

→ **2026-08-19 変更**: 「自作 PR のマージだけは人間の1クリック」は廃止し、Claude が自分でマージする。理由 = kim に毎回1クリックを残すこと自体が §1.1 最上位原則（user の手作業を極限まで減らす）に反しており、実運用でも「マージ待ち」でタスクが滞留していたため。

**人間レビューを外す代わりに CI をゲートにする**。`orgiast-claude-rules` では main に branch protection を設定し、CI ジョブ `test` が green でなければマージできない（`.github/workflows/ci.yml`）。**新しくこの方式を採るリポジトリでは、先に CI を用意してから auto-merge を有効化すること。CI が無いまま自動マージすると検証層がゼロになり、手渡しより悪化する。**

**さらにマージ前の自己検証を必須にする**:

1. **テストを実際に実行して通ることを確認する**（§1.4 verify-before-done。「たぶん通る」でマージしない）。`gh pr checks <PR>` が全て green であること。
2. **変更が依頼スコープ内**であることを diff の**削除行まで**読んで確認する。スコープ外の挙動変更が混じっていたらマージせず報告する（Codex 実装時に頻発する）。
3. **破壊的・不可逆な変更ではない**こと。DB マイグレーション / 本番データ削除 / 秘匿値ローテーション / 課金設定 / 全 PC へ配布される破壊的変更 は、マージ前に user へ確認する。
4. マージ後は **マージ済みである旨とコミット URL** を報告に必ず含める（事後に人が確認できる状態を保つ＝レビューを無くすのではなく事後レビューに移す）。

**CI が「本当に赤くなるか」を一度は確かめること**。赤くならない CI はレビュー代替として無意味。意図的に失敗するテストを注入して非ゼロ終了することを確認し、確認後に必ず復元する（2026-08-19 に実施済み）。

GitHub UI を踏ませる時の注意: private repo は権限の無いアカウントだと 404（"This is not the web page..."）になる。手渡し時は「右上アバターで正しいアカウント（repo owner / collaborator）に切替」を必ず併記する（別アカウントでログインしていて 404 になる事故が頻発）。

過去事例(2026-07-09): PRONI cron 修正で `gh pr merge` を試しもせず「PR をマージしてください」と手渡し → user が GitHub を別アカウント(awardsystem)で開いていて 404 → 「なぜ最初からこちらの手間がかからないようにできないのか。自分たちでできることは振るな。徹底してルール化しろ」と要望。真因 = 手渡しの一文を、自分で試す前に書いたこと。実際は `gh pr merge` まで自分で実行でき、止まったのは「自作 PR の自己マージ」ガードレールのみだった（＝手渡しは最後の1クリックに圧縮できた）。

## 1.1.3.1 環境に合ったツールで実行し直す — Windows は PowerShell tool が本来の経路（2026-08-04 追加）

**ルール**: 1つのツールで実行が通らなかっただけで「自動化できない」と結論して手作業に振ってはいけない。社内の実行環境は Windows なので、**Node スクリプト・Windows パス・PowerShell 前提のツールは PowerShell tool で実行するのが本来の経路**。Bash tool（Git Bash）は POSIX 前提のため、同じことをしても環境差で落ちることがある。

**実例（2026-08-04・学会協賛ナビ）**: 内藤顧問MTGの決定で `deals.commission_pct` の default を 15% → 40% に変える DDL が必要になった。Bash tool 経由では完了せず、いったん「Supabase の SQL Editor で1行実行してください」と手渡しかけた（Stop hook の手作業依頼検出に引っかかった）。その後 **PowerShell tool で `Set-Location "…\web"; node scripts/supabase-sql.mjs "alter table deals alter column commission_pct set default 40.00;"` を実行 → `OK (201)` で完了**。手作業依頼はゼロになった。kim 指示: 「この手作業がゼロになるなら最初からやってほしい」。

**チェック順序（手作業依頼の前に）**:
1. Bash tool で通らない → **PowerShell tool で同じ処理を実行**（Windows ネイティブ）
2. それでも通らない → MCP tool の経路がないか確認（Drive/Sheets/Gmail/Calendar/Discord）
3. 秘匿値が絡む処理は、値を復元したら即 `.env.local` に永続化し、**再利用可能な runner スクリプトを commit する**。以降は「スクリプトに引数を渡すだけ」になり、値の受け渡し自体が発生しない
   - 参考実装: `学会協賛メディア/web/scripts/supabase-sql.mjs`（`.env.local` の `SUPABASE_ACCESS_TOKEN` / `_ALT` / `SUPABASE_PROJECT_REF` を読み、Management API `POST /v1/projects/{ref}/database/query` に任意 SQL を投げる。DDL 可）
4. ここまで全滅して初めて手作業依頼（直URL＋完了判定＋試した経路の列挙＋`[HANDOFF-OK]`）

**Windows Node の exit code に騙されない**: 処理が成功していても終了時に `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76` と exit 9 を返すことがある（libuv の teardown ノイズ）。**標準出力に成功レスポンス（例: `OK (201)`）が出ていれば処理は完了している**。exit code だけ見て失敗と誤判定し、手作業に切り替えてはいけない。必ず read-back verify（例: `information_schema.columns` の `column_default` を読む）で実際の状態を確認してから完了/失敗を判断する。

## 1.1.3.2 user に渡すコマンドはシェルに合わせる（2026-08-04 追加）

kim・社内PCのターミナル既定は **Windows PowerShell 5.1**（pwsh 7 ではない）。

- ❌ `cd "パス" && node script.mjs` → `トークン '&&' は、このバージョンでは有効なステートメント区切りではありません`（ParserError）で**必ず失敗する**
- ✅ `Set-Location "パス"; node script.mjs`
- パスに空白・日本語（`CLAUDE.md配布`、`学会協賛メディア`）が入るので**必ず `"` で囲む**
- Unix コマンド（`head` / `tail` / `which` / `touch` / `wc -l`）も存在しない。PowerShell 相当（`Get-Content -TotalCount` / `-Tail` / `(Get-Command x).Source` 等）に置き換える

過去事例(2026-08-04): `cd "…\web" && node scripts/supabase-sql.mjs "alter table …"` を渡して ParserError で失敗させた。渡す前に「このコマンドは user のシェルで動くか」を必ず確認する。

## 1.1.4 既存リソースの再作成・再作業を絶対に振らない（2026-06-24 追加）

「○○ を新規作成してください」と user に依頼する前に必ず、既存の同等リソースを CLI/API で一覧取得して、既存があれば流用する。既に作成済みのものに「もう一度作って」と振るのは、user の手間を二度かける典型違反。

### 着手前の必須確認コマンド

| リソース種別 | 既存確認コマンド |
|---|---|
| GCP Service Account | `gcloud iam service-accounts list --project=<PROJECT>` |
| GCP Project 自体 | `gcloud projects list` |
| Vercel Project | `vercel projects ls` |
| Vercel Env Variable | `vercel env ls <env>` |
| GitHub Repo | `gh repo list <owner>` |
| GitHub Secret | `gh secret list --repo <repo>` |
| GitHub Workflow | `gh workflow list --repo <repo>` |
| Google Drive / Sheets / Forms | Drive MCP `search_files` で `title contains '<想定名>'` |
| Discord Guild / Channel / Member | Discord MCP `list_channels` / `list_guilds` / `search_members` |
| Supabase Project | 過去 transcript grep / .env.local / Vercel env から復元 |

### 過去事例 (2026-06-24)

EOラーニング企画アプリで Sheets API 用 SA を「GCP Console で新規作成してください」と user に依頼 → user スクリーンショット指摘「既に作ってない？」 → `aujust-sales-automation` project に `eo-learning-sheets-reader@...iam.gserviceaccount.com` が既に存在していた。さらに user 「今後すでに作っているものの作業をこちらに振らないように徹底してルール化して」と明示要望。

### やってはいけない

- 「○○ を新規作成してください」を、既存一覧確認なしで提示
- 「念のためもう 1 つ作りましょう」（重複リソースは管理コスト増）
- 過去 memory に書いてある名前のリソースを「初めて作る前提」で依頼
- スクリーンショットで既存リソースが見えているのに「作成手順」を案内する

### OK パターン

- 「既に `eo-learning-sheets-reader@...` が存在することを確認しました。これに key を 1 つ発行してください（既存に key が無いため）」
- 「既存 Sheet `1YaQc...` を流用します（マニュアル兼企画管理スプレッドシートと同一）」

## hook による強制ガード（2026-06-24 追加・発生率 1% 以下を目標）

memory ルールが Claude の自己規律のみに依存していると、気を抜くと飛ばす（過去事例: Sheet ID を user に振った、DB password を再聞きしようとした、Webhook URL を再作成依頼した）。hook で response を検査して block する仕組み を `~/.claude/settings.json` に組み込む:

| hook | event | 動作 |
|---|---|---|
| `credentials-reminder.ps1` | UserPromptSubmit | user prompt に credentials キーワード(password / token / API key 等)があれば、grep を先に試すリマインダーを additionalContext として inject |
| `automation-first-reminder.ps1` | UserPromptSubmit | 毎ターン強制で 「automation-first 5項チェック」(MCP/CLI/transcript grep/production HTML/自動設定) を additionalContext として inject |
| `manual-handoff-detector.ps1` | Stop | response 内に手作業依頼語彙(環境変数を設定してください/Dashboard で実行してください/コピー貼り付け/番号付き3ステップ手順 等) + 自動化経路への言及が薄い → decision: block で再生成させる |

「ほぼ全部自動化したから最後だけ user に」の妥協は絶対 NG。1 ステップでも user の手間。0 ステップが原則。

例外: 本当に user しかできない作業(OAuth 初回同意 / 支払い / アカウント作成 / 物理操作 / 権限なき他社リソース)は、response に `[HANDOFF-OK]` タグを含めれば Stop hook を通過する。理由を必ず明示する。

## 「分からなければまず install」原則

「○○ CLI が私の環境に無いから手作業で…」は NG。
正しい行動: 「○○ CLI を `winget install` or `scoop install` or `npm i -g` でインストールしてから自動化する」。インストール自体が classifier に止められた場合のみ user に依頼してよい。

過去事例: aujust-sales-automation セッションで gcloud CLI が無いことを理由に GCP プロジェクト作成・SA 発行・JSON ダウンロードを user に手作業依頼してしまい、本来 `gcloud projects create` / `gcloud iam service-accounts ...` で全自動化できたところを汚した。この種の失敗を恒久禁止する。

## 1.2 user に手作業を頼む前に必ず根本診断する

「これはユーザー側で設定する必要がありそう」と感じた瞬間に依頼を出してはいけない。推測で頼まないこと。依頼を出す前に必ず先回りで以下を確認する:

1. エラーメッセージを表層で解釈しない — 同じメッセージが複数原因で出るときは、公式ドキュメント / 過去Issue / 実コードで挙動を確認する
2. プログラム的に確認できる経路を全部試す — CLI で状態を取れるか（`gh status`, `clasp list-deployments`, `vercel ls` 等）、API/MCP で読めるか（Drive MCP, Sheets MCP 等）、ローカル設定ファイルから判別できるか
3. 仮説が複数あるなら、user に頼まなくて済む方を先に検証 — 3つ仮説があって、うち1つだけが user 作業を要するなら、残り2つを潰してからにする
4. 手作業が本当に必要と判明したら、その根拠も併記して依頼 — 「Aを試したらこのエラー、ログから X が原因と判明、Y 以外の経路がないので…」

やってはいけない:
- 「エラー出た → user 設定が怪しい → user に作業依頼」を1行思考でやる
- 「念のため確認してください」型の予防的依頼
- 1 回確認したら分かる項目を「user が知っているはずだから聞こう」で済ませる

Why: user の本業時間を侵食する最大の罪は「実は不要だった作業」を頼むこと。トグルが既にONなのに「OFFかもしれないからONにして」と依頼するパターンは典型的な悪手。
