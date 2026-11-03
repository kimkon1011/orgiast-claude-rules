# 打合せ前日の自動準備

kim-PC の無人タスクが翌日の打合せを列挙し、担当PCの Claude Code に準備を依頼する。担当PCの承諾・起動条件を実測で確認できれば fleet-mail（結果回収可能）を優先する。それ以外はkim-PCでローカル実行する。元のカレンダー予定は変更しない。

## ファイルと配布

- `tools/meeting-prep-dispatch.mjs`: 抽出、照合、配送、結果回収、DWD代行書込。
- `templates/meeting-prep-prompt.md`: 担当PCへの日本語指示と返信JSON契約。
- `config/meeting-prep-routing.json`: 014/008の振分、案件一覧、準備カレンダー名。
- `tools/register-meeting-prep.ps1` / `.mjs`: タスク登録。PowerShellは名簿のkim-PC hostnameとJSTを確認する。
- `tools/setup-manifest.json` / `fleet-scope.json` / `distribution-manifest.json`: `setup --converge` の配布・修復経路。templatesもzip配布する。
- `tools/meeting-prep-dispatch.test.mjs`: 外部サービスを呼ばないモックテスト。

`OrgiastMeetingPrep` は毎日07:00、`OrgiastMeetingPrepCollect` は毎時:40。同期済みmainから非表示起動し、ログイン対話セッションを必要としない。`-Ensure` / `-DryRun` / `-Remove` に対応する。この実装作業では登録・実送信・カレンダー作成を行わない。

## 実行

```sh
node tools/meeting-prep-dispatch.mjs --dry-run --date 2026-11-03
# 両端を含む範囲をまとめて読取（レビューは実行当日分を1回だけ表示）
node tools/meeting-prep-dispatch.mjs --dry-run --date 2026-11-02 --date-to 2026-11-09
node --test tools/meeting-prep-dispatch.test.mjs
# 監督の確認後のみ
node tools/meeting-prep-dispatch.mjs --live
node tools/meeting-prep-dispatch.mjs --live --collect
node tools/meeting-prep-dispatch.mjs --dry-run --identify-014
node tools/meeting-prep-dispatch.mjs --live --identify-014
```

`--live` が無いと常にdry-run。dry-runではGoogle APIのGETと認証、fleetの名簿読取（beacon-listは読取専用POST）のみを行い、業務データ・状態・受信箱・予定・配送を変更しない。実行記録だけは `~/.claude/meeting-prep/runs/<日時>.json` に保存する（`--run-dir` で保存先変更可）。標準出力は件数・成否・詳細パスの1行。`--home` または `ORGIAST_HOME` で実行元のホームを指定できる。鍵は既存 `tools/lib/drive-auth.mjs` の `GOOGLE_SA_KEY` / 既定パスを流用する。トークンを保存・表示しない。

DWDのスコープ:

|用途|スコープ末尾|
|---|---|
|calendarListの全ページ・非表示も含む列挙|calendar.readonly（既存承認を再利用）|
|予定の列挙・準備予定の作成更新|calendar.events|
|共有Gmailスレッド読取（seisaku-teamをDWDで代行）|gmail.readonly|
|案件一覧・ハブの読取|spreadsheets.readonly / drive（既存承認を再利用）|
|代行書込・読戻し|spreadsheets / drive（Docsも承認済みdriveを使用）|

スコープの接頭辞は `https://www.googleapis.com/auth/`。細分化された `calendar.calendarlist.readonly` と `drive.readonly` が未承認でも、承認済みの上表スコープを使う。準備予定はkim@orgiast.jpのprimaryへ作成し、calendar.eventsのみを使用する。カレンダー新設・ACL確認は行わず、追加承認は不要。[Google公式のスコープ一覧](https://developers.google.com/workspace/calendar/api/auth)参照。

## 案件一覧と見出し解決

正本は指定された[案件一覧](https://docs.google.com/spreadsheets/d/14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY/edit)の「案件一覧」。実読の見出しは「ｺｰﾄﾞ」「案件名」「クライアント名」「予算項目」「Mail」「実施計画URL」であり、「案件ID」がA列という前提は使えない。見出し行を検索し、NFKC正規化と別名で全列を解決する。空ID・空案件名・シートエラー値を除き、同一レコードをまとめる。異なる案件情報に同じコードがある場合は送らずskippedに残す。

[制作アプリ案件一覧](https://docs.google.com/spreadsheets/d/1mEa2mLEz0fv7RJIjRu9XsdwzJ-J-DcWw_E0Hyl7ll5A/edit)は補助情報としてのみ使用し、実施計画書IDが一意に一致した行から制作側案件ID・顧客メール・打合せイベントID・フォルダIDを補完する。制作側にしかない案件は正本に追加しない。正本には打合せイベントID列がないため、補完後も0件であれば0と報告する。

dry-runの `caseInventory` は読込案件数・進行中件数・イベントID保有件数・コード重複行数・専用Meet予定数を表示する。前回の0件照合の原因は、指定シートを読み込まず制作アプリ側50件のみを使用し、Meet URL経由の照合もなかったこと。

## 抽出・重複・状態

日付はJSTの開始時刻で判定。終日・辞退・キャンセル・移動・休暇・作業ブロックを除外。祝日、案件専用Meet（ID先頭も照合）、My proposed times、旧専用準備カレンダーを除外する。primary自体は除外せず、private拡張プロパティで準備予定だけを除外する。calendarList/events/Driveはいずれも全ページを読む。列挙失敗は空扱いせず配送を止める。

案件はイベントID、専用Meet URL、案件ID、案件名、顧客名、顧客メールドメインを手掛かりに照合する。専用Meetカレンダーは配送候補には含めず、時間範囲外の恒久Meetも読み、説明・場所・会議情報のURLが同じ予定から案件を引く。同点は未特定。未特定・名称非公開・コード重複は配送対象に入れず、dry-runの `skipped` に理由を出す。配送直前にも拒否する。社内・一般フリーメールのドメインだけでは照合しない。案件が存在しseisaku-teamが主催または参加する打合せは014へ。014を名簿・beaconで解決できない場合は008へ代行し、記録に「014未解決のため008で代行」を残す。予定の無いレビューは主催者の根拠が無いためotherの008へ。

ハブは補助情報として読み、未作成・空・読取不可でもGmailから日次レビューを判定する。認証・読取はschedule-syncと同じ `getDriveToken` のDWD経路（本文抽出もgmail-searchと共用）で、`seisaku-team@orgiast.jp` を代行する。前回の成功した走査以降に更新されたスレッドを全ページ読み、古いメッセージも含むスレッド全体で案件IDか案件名を照合する（完了・失注・中止・アプローチリスト・フェーズ不明を除外）。初回は過去24時間。完了したレビューの時刻より新しい更新だけが対象。

更新時刻の降順で1日10案件まで。同日再実行も送信済みバッチを数え、未完了案件を重ねて依頼しない。上限を超えた更新は `reviewUpdates` に保存して次回へ繰り越す。走査cursorは配送に成功した後だけ進め、案件ごとのreviewed時刻は成果物検証完了まで進めない。翌日打合せがある案件は、送信済み予定でもレビューと重複させない。範囲dry-runはカレンダーを全期間読み、日次レビューを開始日の表示に1回だけ含める（実際の判定時刻はgmail.scannedAt）。

状態は `~/.claude/meeting-prep/state.json`。プロセスロックと原子的保存を使用。案件ID+開始時刻（UTCで正規化）で異なるUIDの同時刻予定もまとめ、旧iCalUIDキーの送信履歴も確認する。対象日+対象keyを送信前に確保する。担当PCへの配送はPCごと1通。ローカルは1ジョブずつ実行する。過大本文・実行失敗は当該バッチに記録し、後続バッチを継続する。

タイムアウトで送信結果不明の場合は自動再送しない。`--collect` は既存fleet-mail送信記録から送信IDを回収し、mail-getで結果を確認する。送信記録も無い場合はstateのsending/errorが残るので監督が配送事実を確認する。完了結果と案件ごとの日次レビューcursorは書込・読戻し・カレンダー反映が済んだ後だけ保存する。failed/expired/needsReviewは完了扱いにしない。

## 受信側の起動条件

既存実装の `fleet-mail --exec claude` は `accept:["claude-resume"]`、`FLEET_HUB=kim-PC`、実在するgit作業ディレクトリを要求する。通常の `prompt` 承諾だけでは起動できない。fleet-directiveは `accept:["prompt"]` とfleet-agent稼働が必要。両方確認済みならfleet-mailを使う。承諾をAIが作成・変更しない。

確認済みの受信側情報は `~/.claude/meeting-prep/receivers.json`（PCラベルをキーにした辞書）に置くか、該当PCから以下の機械可読JSONをfleet-mailで返信する。承諾は継続利用し、実行時にも既存の受信ハンドラが最新のopt-inを検査する。新しい報告で辞退が確認されたら経路を停止する。送信側のopt-inを受信側の証拠として使わない。

```json
{
  "type": "meeting-prep-receiver",
  "label": "DESKTOP-BDOAK99",
  "observedAt": "実測日時ISO8601",
  "accept": ["prompt", "claude-resume"],
  "hub": "kim-PC",
  "cwd": "実測した受信側gitディレクトリ",
  "mailAvailable": true,
  "directiveAvailable": true
}
```

fleet-mailから読む場合、observedAtにはメール受信元のcreatedAtを用いる。JSONは実測情報の例であり承諾済みとの宣言ではない。008の既存返信からhostname・アカウント・nightly-repoパスは確認できたが、claude-resume/hubと現在のprompt承諾を同時に示す証拠は未取得。送信経路の既定はfleet-mail優先、実測情報がない場合は「不明」と記録し、kim-PCへ切り替える。

`fetchBeacons({ home })` はfleet-mailと同じ呼び出し。beaconのhostname・poll・converge成功は稼働情報で、accept/hub/cwdは含まれないため承諾の根拠にはしない。dry-runはPCごとに「opt-in 済み / 未承諾 / 不明」、確認日時、情報源、使える経路を示す。承諾があっても起動条件が欠ければkim-PCで実行する。「未承諾」は受信側の実測accept配列にprompt/claude-resumeがない場合だけ使い、PC未解決や証拠なしを未承諾と断定しない。

未承諾PCでの人の操作（1行）: 該当の作業用008（DESKTOP-BDOAK99）またはhostname特定後の作業用014で、PowerShellから nightly-repo の `tools/fleet-agent.mjs` が表示する `consentCommand('prompt')` 相当の承諾コマンドを本人が実行する（下記）。

```powershell
node -e "const f=require('fs'),o=require('os'),p=require('path').join(o.homedir(),'.claude','fleet-agent-optin.json');let a=[];try{a=JSON.parse(f.readFileSync(p,'utf8')).accept||[]}catch{};f.writeFileSync(p,JSON.stringify({accept:[...new Set([...a,'prompt'])],acceptedAt:new Date().toISOString(),acceptedBy:o.userInfo().username},null,2))"
```

この操作はprompt受付だけを承諾する。fleet-agent稼働と受信側実測報告も必要。AIは承諾ファイルを変更しない。

`--identify-014` は既存fleet-directive-sendを使うkind=status・targets=allの状況照会。既存statusハンドラは自由文の指示を実行せず、hostname/account/prompt opt-in等の定型報告をDiscordと各PCのfleet-agent-last-status.jsonへ出す。リモート名014との対応は自己申告との照合が必要。statusの本文で任意コマンドを実行させるものではない。

## ローカル実行・結果回収・実行記録

受信側のopt-inが確認できない・受付経路がない・PCが未解決の場合は `executedOn: "kim-PC(fallback: <理由>)"` をジョブとバッチに残す。`cheap-code.mjs` のprovider選択・子環境と `claude-exe.mjs` のexe解決を再利用し、GLMまたはDeepSeekで `claude -p` を起動する。Claude API/modelへの追加経路は設けない。cwdは `~/.claude/nightly-repo`、プロンプトはテンプレートとDWD読取資料をstdinで渡す。CLIのツール・MCP・hooksは無効にし、最終JSONのapply/needsReviewだけを受け取る。

DWDで案件のSheets（各タブA1:AZ1000）、案件フォルダ直下のDocs、ハブDoc、直近30日・最大30スレッドの共有Gmailを読む。未読資料・範囲外セルは未確認として明記し、before値を推測させない。モデル出力は保存してから既存applierで適用・読戻しする。部分適用後はcollectで同じJSONを再適用できる。入力が上限を超える場合は要確認として失敗記録する。

資料読取・CLI・適用を含むローカルジョブの上限は15分。超過時は子プロセスを終了し、後続のGoogle API呼出しを中止して次のジョブへ進む。Windowsタスク全体の30分制限は解除し、各ジョブの上限で管理する（登録定義の変更だけでは既存タスクは変更されない）。

全打合せの準備予定を実行開始前に作り、状態（準備中/完了/失敗と理由）と実施計画書・確認シート・提出フォーマット・制作フォルダ・アジェンダのリンクを記録する。未作成・特定できない資料はその旨を記す。適用後は要約と新しいアジェンダURLを更新する。

collectはwhy/本文のmeeting-prepマーカー、またはstate.batchesにあるbatchIdだけを解析する。無関係なメールはログなしで無視し、関連結果がなければfleet認証なしでもexit 0。beacon照会も不要。既知の不正結果・適用失敗・期限切れ等はexit 1。詳細はruns JSONに保存する。

## 返信とDWD代行

返信仕様はテンプレートに記載。fleet-mailの実行結果 `resultBody` をmail-getで読み、PC・replyTo・batchId・対象keyを照合する。`--answer` は既存実装では対話再開用なので使わない。directive経路は担当PCが同じJSONをkim-PC宛noteで返し、通常のfleet-mail受信タスクが受信箱へ取り込む。

readyは検証済み成果物URLを要求。applyは、案件一覧の正本から特定したplan/confirmation/submissionだけに書く。明示矩形範囲とbefore/valuesの寸法を検証し、旧値照合→RAW書込→読み戻しを行う。再試行で既に同じ値なら書かない。人が変更した値は競合停止。Sheets APIの旧値比較と書込は原子的ではないため、同時に同じ範囲を編集する運用は避ける。

許可タブはアジェンダ・実施計画更新・制作物一覧・制作物デザイン・確認事項・提出依頼のみ。アイテムリストと確認事項の既存回答列は拒否する。新規タブのヘッダーはapplierが作成して読む。既存の提出フォーマット等が特定できなければ未完了として止め、似た名前のファイルを推測しない。

補足資料は制作フォルダ内の `<日付>_打合せ補足資料` Google Doc。既存本文とrevisionを照合して更新し読み戻す。アジェンダの `{{document:キー}}` を実URLに置換する。共有権限を変更しない。準備予定は固定IDでupsertし、元の予定ID・元のcalendarIdをprivate拡張プロパティへ保存する。予定自体はprivate・空き時間扱い・招待者なし。作成先はkim@orgiast.jpのprimary（設定prepCalendarIdで変更可）。元予定と同時刻、タイトルは「📋 準備: 元の予定名」、グレー（colorId=8）、通知なし。meetingPrepSourceIdに元予定IDを保存し、元カレンダーIDと予定IDから固定IDを作るため、時刻や案件照合が変わっても重複作成しない。元予定の説明欄は変更しない。

## 検証と本番前の残件

モックテストは予定除外、照合、014代行、同一予定の二重配送防止、PC別集約、送信応答消失、結果の出所照合、カレンダーupsert、applierの競合・再試行・回答列保護を検証する。
2026-11-02の読み取り試験では calendar.readonly / calendar.events / drive / spreadsheets.readonly の認証を確認。専用カレンダー作成・ACL確認は現在廃止し、追加DWD承認は不要。タスク登録のWindows実機検証と外部書込E2Eは、このタスクの「実送信・カレンダー作成をしない」制約により未実施。

2026-11-04のWindows検証: 指定テスト、11/5の読取dry-runが成功。エイト様の同時刻2予定は1ジョブとなり、日次レビュー3件と合わせて4件が `kim-PC(fallback: 受信側opt-in未確認)`。CLIの必要フラグは実機のヘルプで確認した。外部書込・CLIのLLM実行・タスク登録は未実施。

準備予定の作成・更新は `calendar.events` のみ。全カレンダーの列挙には引き続き既存承認の `calendar.readonly` を使う。Docsは既存承認の `drive` スコープを再利用する。
