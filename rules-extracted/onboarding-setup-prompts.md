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
       1) チャット入力ボックスの右下に、今のモードを示すボタン（例: "Auto mode"）が出ています
       2) そのボタンをクリックすると「Modes」メニューが開きます（項目は上から: Ask before edits / Edit automatically / Plan mode / Auto mode）
       3) メニューから一番上の **「Ask before edits」**（編集ごとに承認を求めるモード）を選びます
       4) ボタンの表示が "Auto mode" から "Ask before edits" に変われば解除成功です
       ・補足: このメニューは Shift+Tab でも切り替えられます（メニュー右上に「⇧+tab to switch」と出ています）
     ● ターミナル(CLI)をお使いの場合:
       ・入力欄で Shift+Tab を何回か押すとモードが切り替わります。Auto 以外（default など）になればOK（auto から抜けられれば成功）
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

## 3.0.2 日次コスト自己申告（各PCの使い過ぎを定期監査・報告する）

各PCが「そのPCのClaude Code当月概算コスト（PC名・$合計・モデル別内訳だけ、**会話内容は一切送らない**）」を Discord に日次投稿する仕組み。中央のAPI課金監視(GH Actions)は組織合計しか出せず「どのPC/誰が」が見えないため、per-PCの相対比較と使い過ぎ早期検知はこの自己申告で担う。しきい値: **当月 $150 超で⚠️注視 / $300 超で🚨警告**（全社¥150k≈$1000上限に対する1PCの配分）。Fable5(§1.16)検出でも🚨。

前提: §3.0.1 実行済み（リポジトリが `<ホーム>\orgiast-claude-rules` に clone 済みで `tools/claude-cost-reporter.mjs` が存在すること）。webhook は**公開リポジトリに載せていない秘匿値**なので、運用者(kim等)から私的に共有された #claude-code webhook を使う。

受信側の Claude Code チャットに以下を貼る（§3.0.1 と同じく、auto mode なら手順0で解除を案内してから進める）:

```
このPCの日次コスト自己申告をセットアップして。Claude側で完結させ、settings.json 編集の承認プロンプトは user が「はい」で通す前提で進める（サイレント迂回禁止）。

0. auto mode なら §3.0.1 手順0と同じ要領で user に解除を依頼し、『続けて』が来るまで待つ。

1. レポーター本体の存在確認: <ホーム>\orgiast-claude-rules\tools\claude-cost-reporter.mjs があるか確認（無ければ git clone https://github.com/kimkon1011/orgiast-claude-rules.git を実行、既存なら git pull で最新化）。

2. ~/.claude/cost-reporter.env を作成/確認する（無ければ作る。既にあれば上書きしない）:
   DISCORD_COST_WEBHOOK=<kim から私的に共有された #claude-code webhook。公開リポジトリには無い。分からなければここで user 経由で kim に確認し、値を勝手に作らない>
   REPORTER_LABEL=<このPCが誰のものか分かる名前。例: kim-PC / eigyo-nishi など。省略時はOSホスト名>

3. 動作確認(送信しない): <shell> で node "<ホーム>\orgiast-claude-rules\tools\claude-cost-reporter.mjs" --dry-run を実行し、PC名・MTD$・モデル別内訳が表示されることを確認（--dry-run はDiscordに送らない）。

4. ~/.claude/settings.json の hooks.SessionStart 配列に以下を追記（既存配列は消さず追記、事前に settings.json.bak.<日付>）。この編集の承認プロンプトを user の「はい、今後も許可」で通す:
   {
     "hooks": [
       { "type": "command", "command": "node \"<ホーム>\\orgiast-claude-rules\\tools\\claude-cost-reporter.mjs\"", "timeout": 15, "async": true }
     ]
   }
   （スクリプトに6時間ガードが内蔵されているので、セッションを何度開いても送信は最大6時間に1回。会話内容は読まない/送らない設計。）

5. 完了報告(一行): レポーター配置 / cost-reporter.env 設定済み(webhookの有無) / hook登録済み / --dry-run PASS。webhook が未共有で保留した場合はその旨だけ報告する。
```

これで「中央=組織合計(GH Actions日次) + 各PC=当月概算の自己申告(日次・しきい値アラート付き)」の二層監査が全PCで揃う。会話内容は送らず集計値のみ（memory `feedback-no-blind-exfil-telemetry` の原則: read-only・集計値のみ・review-first を満たす）。

> 限界(把握しておく): 概算はローカルセッション記録(*.jsonl)ベースなので Cowork/claude.ai(web)利用は捕捉外。また表示$は「全トークンをAPI従量換算した理論値」でTeamバンドル分を引いていないため実請求より大きく出る＝PC間の相対比較・急増検知用の指標。正確な実額はAnthropic管理コンソール併用。

## 3.0.3 Gemini CLI 連携（超大規模文脈分析・Google検索を Gemini に委譲）

Claude Code から MCP 経由で Gemini CLI を呼び、**コードベース全体の読み込み・長大ログ/PDF/動画の分析・Google検索**など「Claude単体だとトークンを大量に食う処理」を Gemini(1M文脈)に逃がす。実行者ルーティング(§1.13)の一員。ツール: `googleSearch`（Gemini経由Google検索）/ `geminiChat`（大規模文脈Q&A）。

**⚠️ 認証は GEMINI_API_KEY（Google AI Studio 無料枠）を使う。** 「gemini でログイン(Login with Google / Code Assist 無料枠)」は **2026-07 に Google が個人無料枠を廃止**し `IneligibleTierError: UNSUPPORTED_CLIENT` で弾かれる（実測確認済。OAuth自体は通るが API 呼出が不可）。→ AI Studio の API キーを使う。**各PCが自分の orgiast.jp アカウントで発行**（seisaku-team 運用PCは seisaku-team@orgiast.jp で、他も運用者自身のアカウント。共有しない）。AI Studio 無料枠は追加課金なし（レート/日次上限あり）。

受信側の Claude Code チャットに以下を貼る（MCP登録=~/.claude.json編集の承認が要る場合は §3.0.1 手順0と同じく通常モードで「はい」承認、サイレント迂回は禁止）:

```
Gemini CLI 連携をセットアップして。Claude側で完結させ、質問は最小化する。API キーの発行(ブラウザ)だけが human の1回操作＝そこも「発行ページを開いてキーをコピーするだけ」の状態まで Claude が用意する(§1.1 最上位原則)。

1. Gemini CLI 導入: `npm i -g @google/gemini-cli` を実行し `gemini --version` で確認（既に入っていればスキップ）。

2. GEMINI_API_KEY の受け皿を用意し、human には発行だけさせる:
   - user に直リンクを渡す:「https://aistudio.google.com/apikey を【このPCの運用 orgiast.jp アカウント】で開き、『Create API key / APIキーを作成』→ キーをコピーしてここに1回だけ貼ってください」
   - 受領したキーは即 ~/.gemini/.env に `GEMINI_API_KEY=<値>` として保存し永続化（以降は二度と聞かない。[[credentials-never-reask]]）。既存の環境変数 GEMINI_API_KEY があればそれを使い発行不要。

3. MCP 登録: ~/.claude.json の トップレベル `mcpServers` に以下を追記（既存 mcpServers は消さず追記、事前に ~/.claude.json.bak.<日付> をバックアップ）。**env で GEMINI_API_KEY を渡す**ので MCP 経由の gemini もキーで動く:
   "gemini-cli": { "type": "stdio", "command": "npx", "args": ["-y", "@choplin/mcp-gemini-cli", "--allow-npx"], "env": { "GEMINI_API_KEY": "<手順2のキー>" } }
   （`claude` バイナリがPATHにあれば `claude mcp add -s user gemini-cli -e GEMINI_API_KEY=<キー> -- npx -y @choplin/mcp-gemini-cli --allow-npx` でも同等）

4. 疎通確認: `GEMINI_API_KEY=<キー> gemini -p "reply PONG"` を1回叩き応答が返ることを確認（IneligibleTierError が出るならそれは無料OAuth経路。APIキーが正しく渡っているか再確認）。MCPサーバはセッション開始時ロードのため、登録後は **Claude Code の再起動が必要**。

5. 完了報告(一行): gemini CLI版 / APIキー保存先 / MCP登録済み / 疎通PONG / 再起動要否。キー未発行で保留ならその旨だけ報告。
```

使いどころ（§1.13）: コードベース全体を読ませて設計マップ、長大PDF/動画/音声の要約、最新情報のGoogle検索 等、Claudeの従量トークンを節約したい大規模処理。逆に、少量の事実確認や通常のコード実装(Codex)・多段Web調査+根拠URL(Manus)は各担当のまま。
