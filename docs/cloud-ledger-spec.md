# 仕様: クラウド契約・プロジェクト所在台帳（1スプレッドシート3タブ）

kim 指示 2026-08-28:
「各パソコンの GitHub や Vercel やそれ以外のクラウドの契約しているものを一つのスプレッドシートで管理したい。
プロジェクトの情報やアカウントで迷子になることが多発している」
確認済みの決定: **3タブすべて作る** / **支払い元カードも記載する（下4桁のみ）**。

## 大前提（設計の要・既存の失敗から）

1. **既存のフリートシートに相乗りしない。新規スプレッドシートを作る。**
   既存「オージャストAI設定 実施状況＆整合性チェック」(`14B_vaAr-…`) と
   「備品管理表関係データ保管用」(`1jAOwP…`) は **`anyone`＝編集者**のまま放置されている。
   この台帳は**支払い元カード下4桁**を持つので、`anyone` の器に入れてはならない。
   新規作成し **`DOMAIN`（orgiast.jp 限定）で共有**する。`ANYONE` / `ANYONE_WITH_LINK` は禁止。
2. **PC 側も Claude 側もシート本文を読まない。** 列解決と書き込みは GAS に閉じる。
   検証は `cloud-describe` が返す**件数とキー列だけ**で行う（[[project_pc_inventory_sheet]] と同じ型）。
   カード下4桁を含むセルは `describe` の応答に**絶対に含めない**。
3. **書き込みは許可リスト方式**。ヘッダ名の許可リストに載る列だけ書く。
4. **人間が書いた非空セルを機械が上書きしない。** 空欄のときだけ埋める。
   取得できなかった項目は**セルに触らない**（空文字で潰さない）。
5. **新しい鍵を作らない。** 既存 `FLEET_TOKEN` と既存 Web App（deploymentId `AKfycbwy…`）を使う。
6. **秘匿値を一切読まない・送らない。** 収集側の禁止事項は §C-3 に列挙。

---

## A. 対象スプレッドシート（新規作成）

名称: **`オージャスト クラウド契約・プロジェクト台帳`**
作成は GAS の `setupCloudLedger()` が行う（kim の手作業ゼロ。Drive コマンドキュー経由で実行する）。

`setupCloudLedger()` の責務:
- Script Property `CLOUD_LEDGER_SHEET_ID` が既にあれば**作り直さない**（冪等。二重作成は迷子を増やす）。
- 無ければ `SpreadsheetApp.create(...)` → 3タブを作成しヘッダ行を書く → 既定の `シート1` を削除。
- `DriveApp.getFileById(id).setSharing(DriveApp.Access.DOMAIN, DriveApp.Permission.EDIT)`。
- 作成したファイルを**マイドライブ直下ではなく**、Script Property `CLOUD_LEDGER_FOLDER_ID` があれば
  そのフォルダへ移動する（無ければ移動しない＝失敗させない）。
- 戻り値に `{ ok:true, sheetId, url, tabs:[...], sharing:'DOMAIN' }` を返す。
  URL は `https://docs.google.com/a/orgiast.jp/spreadsheets/d/{ID}/edit` 形式で組み立てる。

### タブ1 `プロジェクト所在地図`（1行 = 1プロジェクト）

| # | ヘッダ | 誰が書くか |
|---|---|---|
| 1 | `プロジェクト名` | 機械（キー） |
| 2 | `用途・説明` | 人 |
| 3 | `GitHubリポジトリ` | 機械（キー・`owner/repo`） |
| 4 | `GitHubアカウント` | 機械 |
| 5 | `可視性` | 機械（`public`/`private`） |
| 6 | `本番URL` | 機械 |
| 7 | `Vercelプロジェクト` | 機械 |
| 8 | `Vercelアカウント/チーム` | 機械 |
| 9 | `Supabaseプロジェクト` | 人（自動検出は任意） |
| 10 | `GASスクリプトID` | 人 |
| 11 | `関連スプレッドシート` | 人 |
| 12 | `開発PC` | 機械 |
| 13 | `ローカルパス(basename)` | 機械 |
| 14 | `最終コミット` | 機械（`YYYY-MM-DD 件名`・件名60字で切る） |
| 15 | `状態` | 人（稼働中/停止/検証中 等） |
| 16 | `備考` | 人 |
| 17 | `更新日時(JST)` | 機械 |

- **キーは `GitHubリポジトリ`（`owner/repo` 完全一致）**。空の行は `プロジェクト名` で突合する。
  どちらも一致しなければ最下部に追記。
- 機械が書いてよいのは上表「機械」の列のみ（＝許可リスト）。人の列は**参照もしない**。
- `開発PC` は「そのリポを直近7日に触った PC ラベル」をカンマ区切り。
  既存値に自分のラベルが無ければ**追記**する（他PCのラベルを消さない）。

### タブ2 `クラウド契約`（1行 = 1契約）

| # | ヘッダ | 誰が書くか |
|---|---|---|
| 1 | `サービス` | 機械（キー） |
| 2 | `アカウント(ログインID)` | 機械（キー） |
| 3 | `プラン` | 人/Claude |
| 4 | `月額(税込)` | 人/Claude |
| 5 | `通貨` | 人/Claude |
| 6 | `支払い元カード(下4桁)` | 人 |
| 7 | `支払い元(名義)` | 人/Claude |
| 8 | `契約者・管理者` | 人 |
| 9 | `用途` | 人 |
| 10 | `関連プロジェクト` | 人 |
| 11 | `管理画面URL` | 人/Claude |
| 12 | `請求サイクル` | 人 |
| 13 | `次回更新日` | 人 |
| 14 | `解約可否メモ` | 人 |
| 15 | `最終確認日` | 機械 |
| 16 | `自動検出` | 機械（`検出済み` / 空） |

- **夜間のPC収集はこのタブに書かない。** 書き込みは `kind:'cloud-contract'` の明示送信のみ。
- ただし `cloud-login` を受けたとき、`(サービス, アカウント)` の組がタブ2に**存在しなければ**
  `サービス` / `アカウント` / `自動検出=検出済み` / `最終確認日` **の4列だけ**で行を追記する。
  → 「契約しているのに台帳に無い」を機械が可視化する。既存行があれば `最終確認日` と `自動検出` のみ更新。
- `最終確認日` と `自動検出` は機械所有列。値が送られたら既存値や `force` に関係なく常に更新する（未送信・空値では触らない）。
- `cloud-contract` は人/Claudeの列も更新できるが、**非空セルは `force:true` のときだけ上書き**する。

### タブ3 `PCログイン`（1行 = PC × サービス × アカウント）

| # | ヘッダ |
|---|---|
| 1 | `PC名/ホスト名`（＝`REPORTER_LABEL`。キー） |
| 2 | `実ホスト名` |
| 3 | `OSユーザー名` |
| 4 | `サービス` |
| 5 | `ログインアカウント` |
| 6 | `スコープ/組織` |
| 7 | `検出元` |
| 8 | `状態`（`ログイン済み` / `未ログイン` / `CLI無し` / `判定不能`） |
| 9 | `CLIバージョン` |
| 10 | `最終報告(JST)` |

- **ラベル単位の全置換**（`gas/fleet-status-sheet/ExtensionAudit.gs` の `extPlanReplace` と同じ型）。
  自分のラベルの行を消してから追記する。他PCの行には触らない。
- `状態` は3値以上の明示値。**取得できないものを「未ログイン」と断定しない**（`判定不能` を使う）。

---

## B. GAS 実装

新規 `gas/fleet-status-sheet/CloudLedger.gs`（I/O）と `gas/fleet-status-sheet/CloudLedgerLogic.gs`（純ロジック）。
既存 `UpsertLogic.gs` / `PcInventoryLogic.gs` と同じ流儀で、純関数は Node 側テストから読める形にする。

### 純関数（`CloudLedgerLogic.gs`）
- `cloudPlanLoginReplace(headers, rows, payload)` → `{ deleteRowNumbers, appendRows }`
- `cloudPlanProjectUpsert(headers, rows, payload)` → `{ updates:[{rowNumber, columnIndex, value}], appendRows }`
- `cloudPlanContractUpsert(headers, rows, payload)` → 同上
- `cloudPlanContractSeed(headers, rows, discovered, today)` → 未登録の `(サービス,アカウント)` だけ追記する計画
- `cloudMergeLabels(existing, label)` → `開発PC` 列のカンマ区切り追記（重複させない・順序安定）

いずれも**シート API を呼ばない**。`fleetFindHeaderIndex`（NFKC正規化＋空白除去）を再利用する。

### I/O（`CloudLedger.gs`）
- `_cloudSheet_(tabName)` … `CLOUD_LEDGER_SHEET_ID` から開く。タブが無ければヘッダ付きで作る。
- `replaceCloudLogins(payload)` / `upsertCloudProjects(payload)` / `upsertCloudContracts(payload)`
- `describeCloudLedger()` … 各タブの **ヘッダ名 / 行数 / キー列の値の一覧のみ** を返す。
  契約内容の検証は、安全な列だけに限定した `describeCloudContracts()` で行う。
- すべて `LockService.getScriptLock()` で 20 秒 tryLock、失敗時は `{ok:false, status:503, error:'busy'}`。
- `setupCloudLedger()` … §A のとおり。

### `WebApp.gs` の `doPost`
既存の三項演算子の連鎖に `cloud-login` / `cloud-project` / `cloud-contract` / `cloud-describe` を足す。
**既存 kind の挙動は1文字も変えない。** `cloud-login` は `label` 必須（無ければ 400 `label_required`）。

### GAS テスト `tools/cloud-ledger-logic.test.mjs`
- **禁止列（カード情報 / `用途` / `備考` / `状態`）が1つも書かれない**こと。
  **列順を200回シャッフルしても成立する**こと（`pc-inventory-logic.test.mjs` と同じ敵対的テスト）。
- 人が書いた非空セルが `force` 無しで上書きされないこと。
- 取得できなかった項目でセルが空にならないこと。
- `cloud-login` が自ラベルの行だけを消し、**他ラベルの行数が変わらない**こと。
- `cloudMergeLabels` が既存の他PCラベルを消さないこと。
- `describeCloudLedger` の応答 JSON に**カード列の値が現れない**こと（文字列検索で検証）。

---

## C. 収集側

### C-1 `tools/cloud-inventory.mjs`（新規・全PCで実行）

各PCのクラウド CLI ログイン状態を集める。出力は
`[{ service, account, scope, source, status, version }]`。

| サービス | 取得方法 | account に入れる値 |
|---|---|---|
| GitHub | `gh auth status` の `Logged in to <host> account <name>` を正規表現で抽出 | ユーザー名 |
| GitHub(git) | `git config --global user.email` | メール |
| Vercel | `vercel whoami`（stdout 最終行）／`vercel teams ls` があれば scope に | ユーザー名 |
| Google Cloud | `gcloud auth list --format=value(account,status)` | アカウント（`*` 付きが active） |
| Google Cloud(project) | `gcloud config get-value project` | scope に入れる |
| npm | `npm whoami`（`ENEEDAUTH` は `未ログイン`） | ユーザー名 |
| clasp | `~/.clasprc.json` の**存在と mtime のみ**。中身は読まない | 空。status=`ログイン済み(アカウント不明)` |
| Supabase | CLI 有無＋`supabase projects list` が 0 終了するか | 空。scope に件数 |
| Cloudflare / AWS / Firebase / Netlify / Railway / Fly / Heroku / DigitalOcean | `command -v` で有無判定。あれば whoami 相当を実行 | 取得できた識別子 |

- **CLI が無い場合は `status='CLI無し'` の行を出さない**（全PCに未導入CLIの行が並ぶとノイズになる）。
  ただし `gh` / `vercel` / `gcloud` の3つだけは未導入でも行を出す（導入漏れを見つけたいため）。
- 各コマンドは**タイムアウト10秒**。全体で60秒を超えない。並列実行してよい。
  **タイムアウトは `status='判定不能'` であって「未ログイン」ではない。**
- `--json` で機械可読、既定は人が読める表。
- 純関数を分離して export しテストする:
  `parseGhAuthStatus(text)` / `parseVercelWhoami(text)` / `parseGcloudAuthList(text)` /
  `parseNpmWhoami(text, exitCode)` / `formatCloudTable(rows)` / `buildCloudLoginPayload(rows, identity)`。
  **OS コマンド実行部分はテストしない**（注入可能にする）。

### C-2 `tools/project-locator.mjs`（新規・kim機のみで実行）

GitHub / Vercel の API からプロジェクト所在地図を作る。

- `gh repo list <owner> --json name,nameWithOwner,visibility,homepageUrl,pushedAt,description --limit 200`
  を、`gh auth status` で見つかった**全アカウント**について実行する。
- `vercel project ls` （出力が人間向けなら `vercel project ls --next` ではなく
  `vercel api /v9/projects` 相当を `vercel` CLI で取得できる形を選ぶ。取得できなければ
  `vercel project ls` のテキストを行パースする純関数を書き、その関数をテストする）。
- Vercel プロジェクトと GitHub リポの紐付けは**リポジトリ名の完全一致**で行う。
  推測での部分一致はしない（別プロジェクトを混ぜるくらいなら空のほうがよい）。
- ローカルの開発実績は既存 `tools/project-inventory.mjs` の `summarizeProjects` を**再利用**する
  （新しく書かない）。`開発PC` と `ローカルパス(basename)` と `最終コミット` はここから。
- 出力 `[{ project, repo, ghAccount, visibility, prodUrl, vercelProject, vercelScope, devPc, localName, lastCommit }]`。
- `--send` で `kind:'cloud-project'` として POST する。

### C-3 収集側の絶対禁止（テストでも固定する）

- `~/.config/gh/hosts.yml` / `%AppData%\GitHub CLI\hosts.yml` の `oauth_token` を読むこと
- `~/.clasprc.json` の中身を読むこと（存在と mtime のみ可）
- `~/.aws/credentials` / `~/.netrc` / `.env*` / keyserve 配布ファイルを読むこと
- 環境変数のうち名前に `KEY` / `TOKEN` / `SECRET` / `PASSWORD` / `CREDENTIAL` を含むものの**値**を送ること
- 会話内容・プロンプト・ファイル本文・フルパス（`basename` のみ可）を送ること
- カード番号・請求金額をPC側から送ること

### C-4 送信 `tools/fleet-sheet-report.mjs`

- `--cloud` を追加。`cloud-inventory.mjs` の結果を `kind:'cloud-login'` として**独立した POST** で送る。
  **`--specs` の教訓**: フラグを付けると payload の kind が変わり通常更新が黙って止まる実装にしない。
  既存の送信内容・行マッチング・既存フラグの挙動は**一切変えない**。
- 送信先 URL / トークンは既存 `~/.claude/fleet-sheet.env` の `FLEET_SHEET_URL` / `FLEET_SHEET_TOKEN` を使う。
  未設定時は stderr へ1行出して `exit 0`（既存の作法どおり）。
- `label` は `tools/reporter-label.mjs` の `resolveReporterLabel` を使う。`hostname` は `os.hostname()`。
  **`COMPUTERNAME` を使わない**（片方だけ違うと label が毎回書き換わりシート行が増殖する既知バグ）。

### C-5 定期実行への配線

- `tools/fleet-poller.mjs` と `tools/fleet-poller.ps1` の**両方**に `--cloud` を追加する。
- `tools/fleet-poller-specs.test.mjs` に倣い、**`--cloud` が呼び出し側に存在することを機械で固定する**
  テストを追加する（`--specs` が抜けていて永久に1台だった事故の再発防止）。
  既存の `--specs` の検査は消さない。

---

## D. やらないこと

- 既存シート（フリート / 備品管理表）へ新しい列やタブを足すこと
- `anyone` 共有のスプレッドシートにカード情報を書くこと
- シート本文を PC 側 / Claude 側で読むこと
- 秘匿値の読み取り・送信（§C-3）
- 取得できない項目を「なし」「未ログイン」と断定すること
- `wmic` の使用
- 新しい鍵・新しい Web App の追加（既存 `FLEET_TOKEN` と既存 deploymentId を使う）
- GAS のデプロイ（別作業。`clasp push -f` → `clasp deploy --deploymentId AKfycbwy…` で URL 維持）

関連: [[project_fleet_status_sheet_sync]] [[project_pc_inventory_sheet]]
[[feedback_delegation_paths_fail_silently]] [[feedback_never_emit_credentials_from_memory]]

## E. 統合（2026-08-30）

フリート稼働状況タブと拡張機能監査タブを「オージャスト クラウド契約・プロジェクト台帳」へ移し、Script Property `SHEET_ID` を台帳 ID に切り替える。以後 `_fleetSheet_()` 経由の書き込みはすべて台帳に入り、旧「オージャストAI設定 実施状況＆整合性チェック」は参照用として残す。

§A の大前提1「既存のフリートシートに相乗りしない」は、フリート側へ台帳を足すのではなく、フリートから DOMAIN 共有の台帳へ吸収する今回の方向でも有効なままである。台帳側への集約により共有範囲も DOMAIN に保たれ、機密面はむしろ強くなる。
