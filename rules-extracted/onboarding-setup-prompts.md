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

受信側の Claude Code チャットに、以下をそのまま貼り付ける（3.0 実行後、または単独でもOK）。

**⚠️ 重要: このセットアップは「通常(非auto)モード」で貼ること。** auto モードだと最後の settings.json 登録が承認プロンプトすら出ずに自動ブロックされ、途中で止まる。貼った後は表示される許可プロンプトに **はい** で答えるだけ（最初の許可プロンプトで「はい、今後も許可」/「always allow」を選べば以降はほぼ聞かれず、貼り付け1回＋数回の「はい」で完了する）。

```
オージャスト共通ルールの自動巡回を設定してください。Claude 側で完結させ、質問は最小化する。このタスクは settings.json への hook 登録という「人間承認が必要な操作」を1つ含む。承認プロンプトが出たら user が「はい」で許可する前提で最後まで進めること（サイレントな迂回＝別ツールで classifier を回避する等は禁止。だが、人間が許可プロンプトを承認して進めるのは正規の完了経路であり、中止理由にはならない）。

0. 【最初に必ず実行・ここで一旦停止して待つ】Claudeは自分のpermission modeを確実には判定できないため、無条件で次を user に丁寧に案内して返事を待つ:
   「このセットアップは settings.json への hook 登録を1つだけ含みます。この操作は安全のため『auto モードだと承認プロンプトすら出さずに自動でブロック』される仕様です（私Claude側や貼り付けテキストからはモードを切り替えられません）。お手数ですが、先に auto mode を解除してください。やり方:
     ● VSCode拡張をお使いの場合:
       1) チャット入力ボックスの下（枠のすぐ下あたり）に、今のモードを示すラベル（例: "Auto" / "自動" 等）が出ています
       2) そのラベルをクリックすると小さなメニューが開きます
       3) メニューから「Manual」（手動承認）を選びます
       4) ラベルの表示が Auto から Manual に変われば解除成功です
     ● ターミナル(CLI)をお使いの場合:
       ・入力欄で Shift+Tab を何回か押すとモードが切り替わります。表示が『default』または『Manual』になればOK（auto から抜けられれば成功）
     ● どうしてもラベルが見つからない/解除できない場合は、その旨を私に伝えてください（無理な回避はしません。§3.0 の手動プル運用という代替もあります）
   解除できたら、このチャットに『続けて』と入力してください。（もともと通常モードだった方は、そのまま『続けて』だけでOKです。）」
   user から続行の合図が来るまで手順1に進まないこと。この後の settings.json 編集は、通常モードなら『許可しますか？』という承認プロンプトが出るので、user が最初のプロンプトで「はい、今後も許可（Yes, allow always）」を選べば以降はほぼ聞かれずに完了する。

1. hook スクリプトを取得する。git clone を優先し、失敗したら WebFetch にフォールバック:
   a. git clone https://github.com/kimkon1011/orgiast-claude-rules.git "<ホームディレクトリ>\orgiast-claude-rules"（クローン済みなら cd して git pull）
   b. a が失敗したら WebFetch: https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/onboarding-sync.ps1
   取得した tools/onboarding-sync.ps1 を ~/.claude/hooks/onboarding-sync.ps1 として UTF-8 BOM付きで保存（git clone 経由ならBOMは既に付いているのでそのままコピー。WebFetch経由の場合のみ先頭に \xEF\xBB\xBF を付与）。スクリプト本体を一読し、GitHub raw への GET と CLAUDE.md/バックアップ/状態JSON/ログ書き込み以外の危険処理が無いことを確認する。

2. シェル検出: `pwsh -v` が成功すれば pwsh、失敗すれば Windows 標準の `powershell`。決めた方を <shell> とする。構文チェック:
   <shell> -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('<フルパス>',[ref]$null,[ref]$null) | Out-Null; 'parse OK'"

3. ~/.claude/settings.json の hooks.SessionStart 配列に以下グループを追記（既存の配列は消さず追記、追記前に settings.json.bak.<日付> でバックアップ、本ルール1.6により編集可）。この編集で許可プロンプトが出るので、user の「はい」で承認して進める。承認されずに書けなかった時だけ手順5の中止報告に回す:
   {
     "hooks": [
       { "type": "command", "command": "<shell> -NoProfile -NonInteractive -File \"<homeディレクトリ>\\.claude\\hooks\\onboarding-sync.ps1\"", "timeout": 20, "async": true }
     ]
   }

4. 動作確認: <shell> -NoProfile -File "<homeディレクトリ>\.claude\hooks\onboarding-sync.ps1" -Force を1回実行し、"[onboarding-sync] updated CLAUDE.md (hash ...)" が出て ~/.claude/CLAUDE.md に最新見出しが入ることを確認する。

5. 完了報告(一行): 使用シェル / 取得経路 / hook登録済み / 動作確認PASS。
   もし手順3で user が承認を拒否した、または人間承認の経路自体が使えず登録できなかった場合のみ、その旨と理由を一行で報告する（その場合も別ツールでの迂回はしない。§3.0 の手動プル運用で代替できる旨だけ添える）。
```

仕組み: SessionStart のたびに GitHub の ONBOARDING.md を取得 → 前回チェックから20時間以上経っていて、かつ内容差分がある時だけ `~/.claude/CLAUDE.md` の `<!-- BEGIN: オージャスト共通ルール -->`〜`<!-- END: オージャスト共通ルール -->` ブロックを置換（マーカーが行全体で完全一致する場合のみ判定、更新前に必ずバックアップ）。オフライン時やGitHub到達不能時は静かに諦めてセッションを妨げない。これで 3.0 の貼り付け作業自体が不要になり、Claude Code を開くだけで常に最新ルールが反映される。

> 補足: マーカー判定は「行完全一致」で行う必要がある（部分一致だと、この設定説明文自身の中に BEGIN/END という文字列が登場するため誤爆する）。過去に実機で2回破損した経緯があるため、この一致方式は変更しないこと（memory `feedback-onboarding-marker-false-match` 参照）。
