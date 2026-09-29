# Claude Code 標準設定書（全アカウント・全PC共通）

版 v2.0／最終更新 2026-09-29／正本: この md（GitHub kimkon1011/orgiast-claude-rules の STANDARD-PC-SETUP.md）。Google Doc はこの md から自動生成（直接編集しない。編集は md → `node tools/gdoc-update.mjs --id 1p9_YkCIXDRbGrFsRDbtNxHVmZ7AglDOqBlamn2Ij4NA --file STANDARD-PC-SETUP.md`）。

この文書は今後、設定が増えるたびにこの1本を更新していく運用です。新しい設定を追加するときは、このページの該当章に追記し、末尾「根拠」に出典を1行足してください。別の文書を新設しないでください。

---

## 0. 新しいPCでやること（これだけ）

### (a) Claude Code がまだ入っていない場合

1. ブラウザで [code.visualstudio.com](https://code.visualstudio.com/) を開き、青い「Download for Windows」ボタンを押してインストーラを実行する（次へ・次へで進めてよい）。所要3分。完了の見え方：デスクトップまたはスタートメニューに青いVS Codeアイコンが現れる。
2. VS Codeを開き、左端の縦アイコン列にある四角が4つ並んだ「拡張機能」アイコンをクリックする。
3. 検索欄に「Claude Code」と入力し、Anthropic社の拡張機能の「Install」ボタンを押す。完了の見え方：左端アイコン列にオレンジの花形マークが追加される。
4. 拡張を開くと自動でログイン画面が出るので、会社のアカウントでログインする。完了の見え方：チャット画面上部にログイン中のメールアドレスが表示される。
5. 失敗したら：インストールが進まない場合は一度VS Codeを閉じて開き直してから再度検索する。それでも失敗する場合はスクリーンショットを金に送る。

### (b) Claude Code のチャット欄に次を貼り付けてEnter

```
https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/STANDARD-PC-SETUP.md を読んで、「Claude Code 向け実行手順」の章どおりにこのPCを標準設定にしてください。本人の操作が必要な箇所では止まって、何を押せばよいか案内してください。
```

### (c) このURLは固定

上記URLは、この文書の内容が更新されても変わりません。ブックマークやショートカットにしておけば、以後もそのまま使えます。

---

## Claude Code 向け実行手順（上から順に実行）

このPCで動いているClaude Codeが、この章を読んで自分で実行するための手順。エラーが出たら推測で回避せず、エラー文をそのまま示して止まること（「止まる条件」参照）。

1. **復旧コマンドを実行する**（git/Node.js/Claude Code/Codex CLIをまとめて自動導入・更新するインストーラ）。PowerShellで次を実行する。

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP 'install-orgiast.ps1'; Invoke-WebRequest -UseBasicParsing ('https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/install-orgiast.ps1?cb='+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -OutFile $p; & $p -NoOllama"
   ```

2. **導入確認**: `git --version` / `node --version` / `claude --version` / `codex --version` を実行し、それぞれバージョンが返ることを確認する。1つでも失敗したら、その時点のエラーをそのまま提示して止まる。

3. **ONBOARDING.md を取り込む**: `https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md` を取得し、`~/.claude/CLAUDE.md` に取り込む（既存があればBEGIN/ENDマーカーでマージ、取り込み前に必ずバックアップを取る）。

4. **`setup --converge` を実行する**（共通の許可ルール・hookをあるべき状態へ収束させる）: `node "$HOME/orgiast-claude-rules/tools/setup.mjs" --converge`。「許可ルール・hookをN件反映しました」の趣旨の結果が出ることを確認する。

5. **4.3の3点チェックを行う**（下の「4.3 導入できているかの確認方法」と同じ）:
   - `<ホームフォルダ>\.claude\skills\session-start\SKILL.md` が存在する
   - `<ホームフォルダ>\orgiast-claude-rules\tools\onboarding-sync.mjs` が存在し、中に `provisionKeys` という文字列が含まれる
   - `<ホームフォルダ>\.claude\settings.json` の `SessionStart` に `onboarding-sync.mjs` が登録されている
   いずれか欠けていたら手順1をもう一度実行する。

6. **各サービスへのログインは、ここで必ず止まって本人に案内する**（パスワード・トークンはチャットで絶対に聞かない）。
   - GitHub: `gh auth login` を実行し、表示された認証用URLをブラウザで開いて承認してもらう。完了の見え方: `gh auth status` が「Logged in to github.com」。
   - Google（clasp用）: `npx clasp login` を実行し、表示された認証用URLをブラウザで開いて会社のGoogleアカウントでログインしてもらう。完了の見え方: ターミナルに「You are logged in as ...」。
   - Vercel: `npx vercel login` を実行し、表示されたURL・確認コードでブラウザ承認してもらう。完了の見え方: ターミナルに「Success!」。
   - どの認証も、画面が開かない・エラーが出る場合は無理に繰り返さず、その場でエラーを提示して止まる。

7. **許可ルール15行（下記5.3）は、Claude Code自身が /permissions を編集しない**（安全上の関門のため）。次の順で進める。
   a. まずAグループ（本番反映9行）を追加してよいか、一文で説明したうえで利用者本人に聞く（「アプリの本番反映コマンドを、毎回の確認なしで実行できるようにする設定です。開発をしない場合は不要です」）。
   b. 回答に応じて、下記5.2の手順を人に案内する形で進行する（`/permissions` → 「Add rule…」→ 1行ずつ貼り付け → 「Add rule」）。Claude Code は画面遷移の案内だけを行い、ルールの追加・削除操作そのものは行わない。

8. **最後に6章の最終チェックリスト（1〜6項目）を実行し、各項目をOK/NGで報告する。** NGがあれば、どの手順に戻ればよいかを添えて報告する。

**止まる条件**: どの手順でもエラーが出たら、エラーメッセージをそのまま提示して次の手順へ進まず止まる。ログイン・許可ルール追加など本人の操作が必要な箇所は、必ず一度立ち止まって案内する。

---

## 1. 目的と「何を・どこへ・なぜ」

オージャスト社内でClaude Codeを使う「全アカウント×全パソコン」が同じ状態になるよう、複数の文書・スクリプトに分かれていた設定手順を1本にまとめています。

- **何を**：Claude Codeの共通設定（自動で入るもの＝ルール取り込み・自己更新・コスト監視 と、手作業が必要なもの＝許可ルール15行）をこの1文書にまとめる。
- **どこへ**：各パソコンのClaude Codeのユーザー設定（そのパソコン・そのアカウントだけに効く）。
- **なぜ**：安全確認（classifier・承認プロンプト）は「人間の理解と同意のための正規の関門」であり、Claude自身やリモートからは解除できない。だからこの文書に沿って、パソコンの前で本人が最小限の操作を行う。それ以外はすべてClaude側で自動化されている。

## 2. 対象と所要時間

- 対象：Claude Codeを使っている全パソコン × 全アカウント（1台に複数アカウントがある場合はアカウントごとに実施）
- 所要時間：初回セットアップ（貼り付けプロンプト）約1分＋自動反映待ち。手作業が必要な許可ルール追加は1台あたり約5分。
- 準備物：この文書をパソコン上で開いておく（コピペで使う）

## 3. 全体の流れ

1. 既にClaude Codeを使っているPCなら、通常は何もしなくても自動で最新状態になっている（下記4.2）。
2. 初めて導入するPC・自動更新が届いていない疑いがあるPCは、上記「0. 新しいPCでやること」または下記4.1の復旧コマンドを実行する。
3. 許可ルール15行（5章）だけは安全上の理由で自動化できないため、利用者本人が1回だけ手作業で追加する。
4. 6章の最終チェックリストで状態を確認し、8章の記録表に記入する。

## 4. 【自動で入るもの】

以下はすべてClaude Code側（SessionStartフック・`setup --converge`・onboarding-sync等）が自動で行う。ユーザーは操作不要。

### 4.1 初回導入・復旧（自動取込）

まだ導入していない、または動きがおかしいPCだけ、次を実行する（実行自体は誰でも可、Claude Codeは不要）。

PowerShell（推奨・Windows）：Windowsキー→「powershell」と入力→Enter→青い画面が開く→右クリックで貼り付け→Enter。所要1分。

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP 'install-orgiast.ps1'; Invoke-WebRequest -UseBasicParsing ('https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/install-orgiast.ps1?cb='+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -OutFile $p; & $p -NoOllama"
```

これでリポジトリ取得・hook登録・初回取込までが自動で完了する。未コミットの作業がある開発機で実行しても、変更は消えず退避される（pullのみ）。

### 4.2 セッションを開くたびに自動で走るもの（登録済みなら以後は完全に無操作）

| 自動処理 | 頻度 | 内容 |
|---|---|---|
| onboarding-sync.mjs | 1日1回（差分がある時だけ） | GitHubの最新ルール（ONBOARDING.md / tools / skills）を取得し、差分をマーカーでマージ |
| setup --converge | セッション開始時 | 共通の許可ルール（allow-rules.json）・hook登録を自動反映 |
| claude-cost-reporter.mjs | 日次 | 当月概算コスト（PC名・$合計・モデル別内訳のみ）をDiscordへ自己申告。$150超⚠️／$300超🚨／Fable5検出🚨 |
| settings-quality-guard.mjs | 設定変更時・セッション開始時 | effortLevelがlowにされたらmediumへ自動復元 |
| fable-session-guard.mjs / model-agent-guard.mjs | 常時 | Fableの用途制限（監督のみ・planIncluded判定）を自動監視 |
| interaction-loop.mjs | 夜間 | 「何回・なぜ手入力させられたか」をローカル計測（外部送信なし） |
| tool-adoption-check.mjs | 日次 | 配布物（tools/等）が最新版と一致しているかを自動点検 |

### 4.3 導入できているかの確認方法（自動で入るもの）

- `<ホームフォルダ>\.claude\skills\session-start\SKILL.md` が存在する
- `<ホームフォルダ>\orgiast-claude-rules\tools\onboarding-sync.mjs` が存在し、中に `provisionKeys` という文字列が含まれる
- `<ホームフォルダ>\.claude\settings.json` のSessionStartに `onboarding-sync.mjs` が登録されている

この3点のいずれかが欠けていたら「配布が届いていない端末」なので、4.1の復旧コマンドを実行する（Claude Codeに頼めば自動で確認・復旧する）。

## 5. 【手作業が必要なもの】許可ルール15行の追加

Claude Codeの一部の操作（本番反映・特定の確認コマンド）は、安全確認の仕組み上、Claude自身やリモートからは「常に許可」に設定できない。パソコンの前で本人が1回だけ設定する。

**必ず先に、そのパソコンの利用者に「この設定を入れてよいか」を確認すること。** 下記Aグループ（9行）はアプリの本番反映を確認なしで実行できるようにするもの。アプリ開発をしない方は入れなくてよい（記録表に「不要」と記入）。

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

## 未確認事項

- kim-PC以外の各PCの実機settings.json（許可ルールの実際の追加状況・アカウント別差分）は未確認。8章の記録表で各PC担当者が実施後に埋める前提。
- 「model」既定値（Opus監督方針）はkim-PCのsettings.jsonに明示キーが無く、claude.ai組織設定側の既定に依存している可能性がある。組織設定側の確認は管理者（kim）のみが行える範囲のため未確認。
