# 新規メンバー取り込み用 貼り付けプロンプト全文

ONBOARDING.compressed.md §3.0 / §3.0.1 の詳細（貼り付けプロンプトの完全版）。

## 3.0 自動取り込み（推奨・コピペ1回で完了）

受信側の Claude Code チャットに、以下のブロック内をそのまま貼り付けるだけ。WebFetch だけで完結するため、gh CLI も Drive MCP も Google Drive コネクタも一切不要。Claude 側で本文取得→マージ→バックアップまで全自動で実行します。

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

配信元: GitHub `kimkon1011/orgiast-claude-rules` (public) — raw URL を WebFetch するだけで取れます。認証も MCP もコネクタも不要。
同じプロンプトを定期的（例: 月1）に再実行すれば最新版に追従できます。BEGIN/END ブロックで置換するので重複しません。

## 3.0.1 完全自動巡回（推奨・これで以後は手動再実行が不要になる）

3.0 は「毎回貼り付ける」手動プル方式。毎回貼らなくても、Claude Code セッションを開くたびに自動で最新版をチェックして反映するようにできる（1日1回まで、差分がある時だけ静かに更新）。

受信側の Claude Code チャットに、以下をそのまま貼り付ける（3.0 実行後、または単独でもOK）:

```
オージャスト共通ルールの自動巡回を設定してください。Claude 側で完結させる。質問は最小化する。

1. hook スクリプトを取得する。git clone (WebFetch単体より制限されにくい経路) を優先し、失敗したら WebFetch にフォールバックする:
   a. git clone https://github.com/kimkon1011/orgiast-claude-rules.git "<ホームディレクトリ>\orgiast-claude-rules"
      (既にクローン済みなら cd してそのディレクトリで git pull)
   b. a が失敗したら WebFetch で取得:
      https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/onboarding-sync.ps1
   c. a・b の両方が環境のセキュリティ機構(classifier)にブロックされた場合、それはバグではなく正当な警戒（「リモートスクリプトを取得して自動実行フックに登録する」パターンは本来警戒対象）。その場合はこのセットアップ自体を中断し、手順5で理由を報告して終了する。手作業の代替手順を案内しない（人に振らない）。
   取得できた本体(tools/onboarding-sync.ps1)を ~/.claude/hooks/onboarding-sync.ps1 として UTF-8 BOM付きで保存
   （BOM必須: 日本語コメントを含むPowerShellスクリプトのため。git clone 経由ならBOMは既に付いているのでそのままコピーでよい。WebFetch経由の場合のみ、保存後に先頭へ \xEF\xBB\xBF が無ければ付与する）

2. 使用可能なシェルを検出する: `pwsh -v` が成功すれば pwsh、失敗する（PowerShell 7 未インストール）場合は Windows 標準の `powershell` を使う。
   このスクリプトは PowerShell 7 専用構文を使っていないため、どちらでも同一に動作する。以後の手順ではこの手順で決めたコマンド名を <shell> として使う。
   決めたシェルで構文チェック:
   <shell> -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('<フルパス>',[ref]$null,[ref]$null) | Out-Null; 'parse OK'"

3. ~/.claude/settings.json の SessionStart hooks 配列に、手順2で決めた <shell> を使って以下を追加（既存の hooks 配列は消さず追記、追加前に settings.json.bak.<日付> でバックアップ、本ルール1.6により無断編集可）:
   {
     "hooks": [
       {
         "type": "command",
         "command": "<shell> -NoProfile -NonInteractive -File \"<ユーザーのhomeディレクトリ>\\.claude\\hooks\\onboarding-sync.ps1\"",
         "timeout": 20,
         "async": true
       }
     ]
   }

4. 動作確認として一度 -Force 付きで手動実行し、~/.claude/CLAUDE.md に最新見出しが入ることを確認する
   （本番ファイルを直接いじる前に、テスト用の一時ファイルに -TargetPath で向けて動作確認してから本番実行するとより安全）

5. 完了報告: 使用したシェル(pwsh/powershell)・取得経路(git clone/WebFetch)・hook登録済み・動作確認PASSであることを一行で報告する。手順1cで中断した場合はその旨とブロックされた理由を一行で報告し、それ以上の代替手段(手作業依頼等)は提示しない
```

仕組み: SessionStart のたびに GitHub の ONBOARDING.md を取得 → 前回チェックから20時間以上経っていて、かつ内容差分がある時だけ `~/.claude/CLAUDE.md` の `<!-- BEGIN: オージャスト共通ルール -->`〜`<!-- END: オージャスト共通ルール -->` ブロックを置換（マーカーが行全体で完全一致する場合のみ判定、更新前に必ずバックアップ）。オフライン時やGitHub到達不能時は静かに諦めてセッションを妨げない。これで 3.0 の貼り付け作業自体が不要になり、Claude Code を開くだけで常に最新ルールが反映される。

> 補足: マーカー判定は「行完全一致」で行う必要がある（部分一致だと、この設定説明文自身の中に BEGIN/END という文字列が登場するため誤爆する）。過去に実機で2回破損した経緯があるため、この一致方式は変更しないこと（memory `feedback-onboarding-marker-false-match` 参照）。
