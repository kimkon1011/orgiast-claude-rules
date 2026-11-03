# Claude Code 標準設定書（全アカウント・全PC共通）

版 v2.2／最終更新 2026-10-29／正本: この md（GitHub kimkon1011/orgiast-claude-rules の STANDARD-PC-SETUP.md）。Google Doc はこの md から自動生成（直接編集しない。編集は md → `node tools/gdoc-update.mjs --id 1p9_YkCIXDRbGrFsRDbtNxHVmZ7AglDOqBlamn2Ij4NA --file STANDARD-PC-SETUP.md`）。

この文書は今後、設定が増えるたびにこの1本を更新していく運用です。新しい設定を追加するときは、このページの該当章に追記し、末尾「根拠」に出典を1行足してください。別の文書を新設しないでください。

---

## 0. 新しいPCでやること（これだけ）

### (a) Claude Code がまだ入っていない場合

1. ブラウザで [code.visualstudio.com](https://code.visualstudio.com/) を開き、青い「Download for Windows」ボタンを押してインストーラを実行する（次へ・次へで進めてよい）。所要3分。完了の見え方：デスクトップまたはスタートメニューに青いVS Codeアイコンが現れる。
2. VS Codeを開き、左端の縦アイコン列にある四角が4つ並んだ「拡張機能」アイコンをクリックする。
3. 検索欄に「Claude Code」と入力し、Anthropic社の拡張機能の「Install」ボタンを押す。完了の見え方：左端アイコン列にオレンジの花形マークが追加される。
4. 拡張を開くと自動でログイン画面が出るので、会社のアカウントでログインする。完了の見え方：チャット画面上部にログイン中のメールアドレスが表示される。
5. 失敗したら：インストールが進まない場合は一度VS Codeを閉じて開き直してから再度検索する。それでも失敗する場合はスクリーンショットを金に送る。

### (b) Claude Code のチャット欄に次の**どちらか1つ**を貼り付けてEnter

アプリ開発（GAS・Webアプリの本番反映）をする人:

```
https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/STANDARD-PC-SETUP.md を読んで、「Claude Code 向け実行手順」の章どおりにこのPCを標準設定にしてください。本番反映の許可ルール（Aグループ）は入れてください。質問せずに最後まで進め、私がするのはブラウザでのログイン承認だけにしてください。
```

アプリ開発をしない人:

```
https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/STANDARD-PC-SETUP.md を読んで、「Claude Code 向け実行手順」の章どおりにこのPCを標準設定にしてください。本番反映の許可ルール（Aグループ）は入れないでください。質問せずに最後まで進め、私がするのはブラウザでのログイン承認だけにしてください。
```

本人がする操作は、途中で開くブラウザ画面でのログイン承認（GitHub・Google・Vercel・ChatGPT の4つ）だけ。それ以外はすべて Claude が行い、最後に結果の表を出す。

### (c) このURLは固定

上記URLは、この文書の内容が更新されても変わりません。ブックマークやショートカットにしておけば、以後もそのまま使えます。

---

## Claude Code 向け実行手順（上から順に実行）

このPCで動いているClaude Codeが、この章を読んで自分で実行するための手順。

### 手順0 進め方の原則（最初に読む）

- **本人に頼むのはブラウザでのログイン承認だけ**。コマンド実行・設定ファイル編集・許可ルール追加・確認作業は、すべて Claude が行う。この文書のほかの章に「本人が操作」と書かれていても、まず Claude 側で最小単位を1回試し、できたらそのまま進める（2026-10-29 user-PC で許可ルール15行を本人に貼らせて差し戻された）。
- **質問しない**。Aグループ（本番反映9行）の可否は貼り付け文に書いてある。書いていない古い貼り付け文のときだけ、最初の返答で1回だけ聞き、返事を待つ間も手順1〜6を止めずに進める。
- **ログインは早く始める**。手順1が終わったらすぐ手順6のログイン画面を起動し、本人が承認している間に手順2〜5を並行して進める。
- **既知の詰まりは自分で直して続行する**（下の「詰まり対処表」）。表にない未知のエラーだけ、エラー文をそのまま示して止まる。
- **報告は最後に表1枚**。途中は1行の進捗だけにし、本人に確認を求めない。

### 手順1 復旧コマンドを実行する

（git/Node.js/Claude Code/Codex CLIをまとめて自動導入・更新するインストーラ）。PowerShellで次を実行する。

```
$p = Join-Path $env:TEMP 'install-orgiast.ps1'; Invoke-WebRequest -UseBasicParsing ('https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/install-orgiast.ps1?cb='+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p -NoOllama -NoReboot -NonInteractive
```

Claude Code からは自動再起動しない。ログインは手順6でまとめて行う。

### 手順2 導入確認

`git --version` / `node --version` / `claude --version` / `codex --version` を実行し、それぞれバージョンが返ることを確認する。1つでも失敗したら、その時点のエラーをそのまま提示して止まる。

### 手順3 ONBOARDING.md を取り込む

`https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md` を取得し、`~/.claude/CLAUDE.md` に取り込む（既存があればBEGIN/ENDマーカーでマージ、取り込み前に必ずバックアップを取る）。

### 手順4 `setup --converge` を実行する

（共通の許可ルール・hookをあるべき状態へ収束させる）: `~/.claude/settings.json` の SessionStart にある `setup.mjs --converge` のパスで実行する。登録が無ければ `node "$HOME/orgiast-claude-rules/tools/setup.mjs" --converge`。「許可ルール・hookをN件反映しました」の趣旨の結果が出ることを確認する。

### 手順5 4.3の3点チェックを行う

（下の「4.3 導入できているかの確認方法」と同じ）:
- `<ホームフォルダ>\.claude\skills\session-start\SKILL.md` が存在する
- `<ホームフォルダ>\orgiast-claude-rules\tools\onboarding-sync.mjs` が存在し、中に `provisionKeys` という文字列が含まれる
- `<ホームフォルダ>\.claude\settings.json` の `SessionStart` に `onboarding-sync.mjs` が登録されている
いずれか欠けていたら手順1をもう一度実行する。

### 手順6 ログイン4件を1つの見える画面で行う

（パスワード・トークンはチャットで絶対に聞かない）。`node <repo>/tools/make-desktop-launcher.mjs --name "オージャスト ログイン4件" --ps-file <repo>/tools/login-services.ps1` でデスクトップに置き、Claude 自身が `Start-Process` で起動する。利用者にコマンドを貼らせない。

起動前にツールと同じ案内（全て `seisaku-team@orgiast.jp`）を示す。GitHub は「Y/n → Enter」、コード表示後 Enter、ブラウザで Ctrl+V → Continue → Authorize GitHub CLI。Google (clasp) は自動で開いた Google 画面を承認。Vercel は表示URLと確認コードを承認。Codex は ChatGPT の会社アカウントを承認。localhost の Windows Defender 警告は「キャンセル」でよい（PC内通信のみ）。残った AI Studio ・ localhost エラーのタブは閉じてよい。

Claude は5秒ごとに `gh auth status` / `~/.clasprc.json` / `npx -y vercel whoami` / `~/.codex/auth.json` の tokens を判定し、4件すべて完了するまで待つ。

**詰まり対処表**（2026-10-29 user-PC の実測。どれも Claude が自分で対処し、本人には頼まない）

| 症状 | 対処 |
|---|---|
| インストーラが「見つかりません」を連発する | `orgiast-claude-rules\orgiast-claude-rules-main` が二重入れ子になっている。最新のインストーラは自動で修復するので、手順1を再実行する |
| `gh` が見つからない（Claude の PowerShell/Bash から） | 導入直後で PATH が古い。`C:\Program Files\GitHub CLI\gh.exe` をフルパスで呼ぶ |
| 手順4で json-valid の NG が十数件出る | hook の参照先と別のクローンで検証している。settings.json に登録されているパスの setup.mjs で再実行する |
| Bash が LANE-REPAIR-FIRST の hook で止まる、または Codex 委譲ができない | Codex が未ログイン。手順6でログインが済めば解消するので、それまでは PowerShell ツールで進める |
| clasp でブラウザが開かない、localhost が ERR_CONNECTION_REFUSED になる | login-services.ps1 が URL を抽出して開き直す。古いタブは閉じてよいと本人に1行で伝える |
| 許可ルールを /permissions で入れるよう求められている気がする | 手順7のツールで Claude が入れる。本人には頼まない |

### 手順7 許可ルール15行（下記5.3）は Claude Code が追加する（本人に /permissions を操作させない）

- Aグループ（本番反映9行）の可否は貼り付け文の指定に従う。指定のない古い貼り付け文のときだけ、手順0のとおり最初の返答で1回だけ聞く（「アプリの本番反映コマンドを、毎回の確認なしで実行できるようにする設定です。開発をしない場合は不要です」）。
- 了承あり: `node <手順4と同じ tools>\add-permission-rules.mjs --with-prod`。了承なし: `--with-prod` を付けずに実行（Bの6行だけ）。settings.json のバックアップを取ってから追記し、最後に `N/N present` と表示されれば完了（exit 0）。
- bypassPermissions 既定（5.4）では Claude が settings.json を編集できる。2026-10-29 user-PC で「Claude は編集しない」旧記述のまま本人に15回の貼り付けを頼み、差し戻された（他アカウントは Claude が追加済み）。5.2 の画面手順は、Claude Code が使えない場合の予備としてだけ使う。

### 手順8 最後に6章の最終チェックリスト（1〜6項目）を実行し、各項目をOK/NGで報告する

すべて Claude が自分で確認する（本人に画面を見せて確認させない）。項目3は `add-permission-rules.mjs --check`（Aの了承があれば `--with-prod --check`）、項目6は `~/.claude/.cost-reporter-state.json` の `lastRun` が24時間以内かで判定する。NGは、Claude が該当の手順に戻って直してから報告する。

**止まる条件**: 詰まり対処表にない未知のエラーだけ、エラーメッセージをそのまま示して止まる。本人の操作はブラウザでのログイン承認だけ。

### 手順9 今回詰まった点があれば、この文書を直す

手順0の原則から外れて本人に操作や確認を頼んだり、詰まり対処表にない詰まりが出たりしたら、終了前に原因と対処をこの文書（手順0・詰まり対処表・該当手順）に追記して PR を出す。次の人が同じところで止まらないようにするため。

---

## 1. 目的と「何を・どこへ・なぜ」

オージャスト社内でClaude Codeを使う「全アカウント×全パソコン」が同じ状態になるよう、複数の文書・スクリプトに分かれていた設定手順を1本にまとめています。

- **何を**：Claude Codeの共通設定（ルール取り込み・自己更新・コスト監視・許可ルール15行）をこの1文書にまとめる。
- **どこへ**：各パソコンのClaude Codeのユーザー設定（そのパソコン・そのアカウントだけに効く）。
- **なぜ**：全PCを同じ状態にするため。本人の操作はログイン承認と、本番反映の許可ルール（Aグループ）を入れるかの意思表示（貼り付け文の選択）だけで、それ以外はすべてClaudeが行う。

## 2. 対象と所要時間

- 対象：Claude Codeを使っている全パソコン × 全アカウント（1台に複数アカウントがある場合はアカウントごとに実施）
- 所要時間：貼り付け1回＋ログイン承認4件（約5分）。残りは Claude が自動で進める。
- 準備物：この文書をパソコン上で開いておく（コピペで使う）

## 3. 全体の流れ

1. 既にClaude Codeを使っているPCなら、通常は何もしなくても自動で最新状態になっている（下記4.2）。
2. 初めて導入するPC・自動更新が届いていない疑いがあるPCは、上記「0. 新しいPCでやること」または下記4.1の復旧コマンドを実行する。
3. 許可ルール15行（5章）は Claude が `tools/add-permission-rules.mjs` で追加する（Aグループは貼り付け文で了承した人だけ）。
4. 6章の最終チェックリストで状態を確認し、8章の記録表に記入する。

## 4. 【自動で入るもの】

以下はすべてClaude Code側（SessionStartフック・`setup --converge`・onboarding-sync等）が自動で行う。ユーザーは操作不要。

### 4.1 初回導入・復旧（自動取込）

まだ導入していない、または動きがおかしいPCだけ、次を実行する（実行自体は誰でも可、Claude Codeは不要）。

PowerShell（推奨・Windows）：Windowsキー→「powershell」と入力→Enter→青い画面が開く→右クリックで貼り付け→Enter。所要1分。

```
powershell -NoProfile -ExecutionPolicy Bypass -Command '$p=Join-Path $env:TEMP ''install-orgiast.ps1''; Invoke-WebRequest -UseBasicParsing (''https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/install-orgiast.ps1?cb=''+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -OutFile $p; & $p -NoOllama'
```

この1行は Windows PowerShell 5.1 / pwsh のどちらから貼っても、外側のシェルが `$p` を先に展開しない。

これでリポジトリ取得・hook登録・初回取込までが自動で完了する。未コミットの作業がある開発機で実行しても、変更は消えず退避される（pullのみ）。

### 4.2 セッションを開くたびに自動で走るもの（登録済みなら以後は完全に無操作）

| 自動処理 | 頻度 | 内容 |
|---|---|---|
| onboarding-sync.mjs | 1日1回（差分がある時だけ） | GitHubの最新ルール（ONBOARDING.md / tools / skills）を取得し、差分をマーカーでマージ |
| setup --converge | セッション開始時 | 共通の許可ルール（allow-rules.json）・hook登録を自動反映 |
| claude-cost-reporter.mjs | 日次 | 当月概算コスト（PC名・$合計・モデル別内訳のみ）をDiscordへ自己申告。$150超で「注意」／$300超で「警告」／Fable5検出で「警告」 |
| settings-quality-guard.mjs | 設定変更時・セッション開始時 | effortLevelがlowにされたらmediumへ自動復元 |
| fable-session-guard.mjs / model-agent-guard.mjs | 常時 | Fableの用途制限（監督のみ・planIncluded判定）を自動監視 |
| interaction-loop.mjs | 夜間 | 「何回・なぜ手入力させられたか」をローカル計測（外部送信なし） |
| tool-adoption-check.mjs | 日次 | 配布物（tools/等）が最新版と一致しているかを自動点検 |

### 4.3 導入できているかの確認方法（自動で入るもの）

- `<ホームフォルダ>\.claude\skills\session-start\SKILL.md` が存在する
- `<ホームフォルダ>\orgiast-claude-rules\tools\onboarding-sync.mjs` が存在し、中に `provisionKeys` という文字列が含まれる
- `<ホームフォルダ>\.claude\settings.json` のSessionStartに `onboarding-sync.mjs` が登録されている

この3点のいずれかが欠けていたら「配布が届いていない端末」なので、4.1の復旧コマンドを実行する（Claude Codeに頼めば自動で確認・復旧する）。

## 5. 許可ルール15行の追加（Claude が行う）

Claude Codeの一部の操作（本番反映・特定の確認コマンド）を「常に許可」にする設定。追加は Claude Code が `tools/add-permission-rules.mjs` で行う（手順7）。本人の操作は、Aグループを入れてよいかの返事1回だけ。下の5.2は Claude Code が使えない場合の予備手順。

下記Aグループ（9行）はアプリの本番反映を確認なしで実行できるようにするもの。入れるかどうかは利用者が0(b)の貼り付け文を選ぶことで意思表示する。アプリ開発をしない方は入れなくてよい（記録表に「不要」と記入）。

### 5.1 各設定が何を変えるか（一文で）

- **Aグループ（9行）**：GAS（Apps Script）やWebアプリの本番反映コマンドを、毎回の確認なしで実行できるようにする。Claudeが本番に反映するときに人の確認が挟まらなくなるため、開発をしない方は入れないこと。
- **Bグループ（6行）**：中身を読むだけの確認コマンド（シークレット一覧・スケジュールタスク確認等）を、毎回の確認なしで実行できるようにする。何かを変更する操作ではない。

### 5.2 手順（1台・1アカウントごと・所要約5分）

1. パソコンで**Visual Studio Code（青いアイコン）**を開く。見つからない場合は、Windowsキーを押して「Visual Studio Code」と入力し、Enterを押す。
2. 左端のアイコン列にある**Claudeのマーク（オレンジの花形）**をクリックする。右か左にClaude Codeのチャット画面が開く。
3. チャット画面の上のほうで、ログイン中のアカウント（メールアドレス）を確認し、8章の記録表に書く。
4. 画面下のチャット入力欄をクリックし、半角で `/permissions` と入力してEnterを押す。
5. 「Permission rules」という画面が開く。**「Add rule…」**（または「Add a new rule…」）をクリックする。
6. 入力欄に5.3のルールを**1行だけ**コピーして貼り付ける。「Save for」は**all projects**（またはUser settings）のままにして、**「Add rule」**ボタンを押す。
7. 手順5〜6を、5.3の15行すべてについて繰り返す。
8. 終わったら右上の×で画面を閉じる。

**こんな表示が出たら**

- 赤い枠で「… is already in the allow rules」：そのルールはすでに入っている。問題ない。「Cancel」を押して次の行に進む。
- 「/permissions」を入れても画面が開かない：Claude Codeが古い可能性がある。記録表に「画面が開かない」と書き、画面のスクリーンショットを撮って金に送る。
- 黒い画面（ターミナル）でClaude Codeを使っているパソコン：黒い画面で同じく `/permissions` と入力してEnterを押し、矢印キーで「Add a new rule…」を選んでEnter、ルールを貼り付けてEnter、保存先を聞かれたら「User settings」を選んでEnter、の順で進める。

**うまくいったかの確認**

もう一度 `/permissions` を開くと、「ALLOW」の一覧に5.3のルールが並んでいる。一覧は数が多いので、上の検索欄に「clasp」や「vercel」と入れると見つけやすい。

### 5.3 追加するルール（15行・1行ずつコピー。記号もそのまま）

**A. アプリの本番反映（9行）**※利用者の了承がある場合のみ

```
Bash(clasp push*)
Bash(clasp deploy*)
Bash(clasp version*)
Bash(npx clasp push*)
Bash(npx clasp deploy*)
Bash(vercel --prod*)
Bash(vercel deploy --prod*)
Bash(npx vercel --prod*)
Bash(npx vercel deploy --prod*)
```

**B. 確認作業（6行）**※中身を読むだけで、何かを変更する操作ではない

```
Bash(gh secret list*)
Bash(gh variable list*)
Bash(curl -s "https://raw.githubusercontent.com/kimkon1011/*")
PowerShell(node * makimono-publish.mjs *)
PowerShell((Get-ScheduledTask*).Actions.Arguments)
PowerShell(Get-ScheduledTask -TaskName *)
```

### 5.4 その他、手作業が必要になりうる設定（通常は不要）

| 設定項目 | 既定値・自動化の状態 | 手作業が必要になる場合 |
|---|---|---|
| permission mode（安全確認の厳しさ） | 既定 bypassPermissions＝Claudeが操作のたびに確認を求めずに実行するモード（禁止リスト＋hookの2層で危険操作は止める、2026-09-17 kim決定）。設定ファイルに自動で入る。起動時に英語の警告「Bypass Permissions mode」が出たら「Yes, I accept」を選ぶ（本人の同意操作） | 個別PCで従来のautoモードを維持したい場合のみ、環境変数 `ORGIAST_KEEP_PERMISSION_MODE=1` を手動設定（何が変わるか：安全確認の頻度が上がり、Claudeの自動実行が遅くなる代わりに人の目が増える） |
| effortLevel（思考の深さ） | 既定 medium固定。lowへの変更は自動でブロック・復元される（2026-09-17 kim改定） | 設計・横断調査のセッションだけ一時的にhighへ、Claudeが自分で切替可能。ユーザー操作は不要 |
| Fable5の利用 | fable-policy.jsonのplanIncludedで判定。監督（設計・指示・レビュー）のみ許可、実装・量産は禁止。hookが自動監視 | プラン変更時、支出レポートで金額を再確認するのは管理者（kim）のみの作業 |

## 6. パソコンごとの最終チェックリスト

この状態になっていればOK。1項目ずつ、見え方つきで確認する。

| # | 確認項目 | 見え方（OKの状態） |
|---|---|---|
| 1 | Claude Code拡張がVSCodeに入っている | 左端アイコン列にオレンジの花形マークがある |
| 2 | 自動取込が届いている（4.3の3点） | Claudeに「配布状態を確認して」と聞けば自動で3点チェックして報告する |
| 3 | 許可ルール15行が入っている（Aは了承者のみ） | /permissionsの「ALLOW」一覧に15行（Aの了承がない場合は6行）が表示される |
| 4 | permission modeがbypassPermissions | ~/.claude/settings.jsonのpermissions.defaultModeが"bypassPermissions" |
| 5 | effortLevelがmedium | 同ファイルの"effortLevel": "medium" |
| 6 | 日次コスト自己申告が届いている | Discordに当月コストの自己申告メッセージが日次で届く |

## 7. 困ったとき

- 画面が説明と違う／ボタンが見つからない → 操作を止めてスクリーンショットを撮り、金（kim@orgiast.jp）にDiscordで送る。無理に推測で進めない。
- 許可ルールを間違えて追加した／消したい → 自分で消さず金に相談する（許可ルールの削除・変更は「緩める方向」の操作のため人の判断が必要）。
- 復旧コマンドを実行してもエラーが出る → エラー文をそのままコピーして金に送る。
- プロジェクト固有の運用が必要な場合 → そのリポジトリ直下のCLAUDE.mdが本書より優先される。

## 8. 記録表

| パソコン名・利用者 | アカウント（メール） | 実施日 | 4章 自動取込（済/不要） | 5.3-A 9行（済/不要） | 5.3-B 6行（済） | メモ |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |

記録表を埋めたら、このドキュメントのリンクを金にDiscordで送ること。「画面が開かない」などがあったパソコンは、金（またはClaude）が個別に対応する。

## 根拠（採用した値と出典）

- 許可ルール15行の内容・手順文言：既存Doc「Claude Code 許可設定の追加手順（全PC共通）」（Drive ID 1mMFbwpDvMZtvqY89oIMzOLKIZdzD2aVPvq4dH5DtJ_w、2026-09-28作成）をそのまま統合。日付が最新かつ唯一の情報源のため採用。
- permission mode既定bypassPermissions：ONBOARDING.md §1.14（2026-09-17 kim決定）。実機 `C:\Users\uers\.claude\settings.json` のpermissions.defaultModeが実際に"bypassPermissions"であることと一致（2026-09-28時点で確認）。
- effortLevel既定medium・low禁止：ONBOARDING.md §1.13.1（2026-09-17 kim改定）。実機settings.jsonの"effortLevel": "medium"と一致。
- 自動取込・setup --converge・onboarding-syncの挙動：ONBOARDING.md §3.0〜3.0.5。
- 「allowルールはsetup --convergeで入り、既に配布済みツール（~/orgiast-main/tools/*.mjs等）はwildcard許可済みで個別追加不要」というmemory（index/devtools.md「allowルールはsettings.json直編集でなくsetup --converge…（2026-09-17実測）」）と、「15行は手作業でUI追加」という既存Doc（2026-09-28）は矛盾ではなく役割分担と判断した：setup --convergeが自動でカバーするのはtools/配下のwildcard許可のみで、本番反映系コマンド（clasp/vercelの直接実行）と一部の確認コマンドはwildcard対象外のため、既存Docの手作業手順（日付が新しい・実際にUI操作が必要と明記）をそのまま採用した。
- Fable5用途制限：ONBOARDING.md §1.16（2026-09-03改定）。
- 実機settings.json全体（permissions.allow/deny/ask・hooks構成）は2026-09-28時点のkim-PCを実例として参照し、秘密値・トークン・APIキーは本文に一切転記していない。
- 新規PC節の必須ツール一覧（git/Node.js/Claude Code/Codex CLI）：orgiast-claude-rules/tools/setup-manifest.json（severity: requiredの4項目）。
- winget導入コマンド・自動導入の実体：tools/install-orgiast.ps1・tools/bootstrap.ps1。
- gh／clasp／vercelの位置づけ：rules-extracted/project-launch-playbook.md（ghのwinget導入コマンド）、および実機settings.jsonのpermissions.allowにnpx clasp *・npx vercel *系が多数登録されていること（個別インストールでなくnpx経由が実運用）。
- VS Code拡張の前提：既存Doc「Claude Code 許可設定の追加手順」の手順文中の記述、および tools/RESTORE-claude-backup.md のVS Code拡張導入手順。
- 2026-10-29 user-PC 実測：pwsh の `$p` 先行展開、自動再起動、Gemini 非対話入力、zip 二重入れ子、hook 誤NG、4サービス認証の迷いを再現し、v2.1 で是正。

## 未確認事項

- kim-PC以外の各PCの実機settings.json（許可ルールの実際の追加状況・アカウント別差分）は未確認。8章の記録表で各PC担当者が実施後に埋める前提。
- 「model」既定値（Opus監督方針）はkim-PCのsettings.jsonに明示キーが無く、claude.ai組織設定側の既定に依存している可能性がある。組織設定側の確認は管理者（kim）のみが行える範囲のため未確認。
