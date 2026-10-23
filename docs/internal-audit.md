# 社内不正・リスク監査 V1.3

検出は確認の手掛かりであり、不正の断定ではありません。支払先との取引実態を契約書・請求書・承認記録で確認してください。取得失敗や権限不足を「問題なし」「形跡なし」に置き換えません。

## 実行

Node.js 20.11+（AbortSignal.any 対応）、既存 dependency の `postgres` を使用します。

```sh
node tools/internal-audit.mjs --window-days 90 --json /secure/snapshot.json --out /secure/report.md
node tools/internal-audit.mjs --snapshot /secure/snapshot.json --skip gmail,drive,discord,admin,web,patterns --out /secure/replay.md
node tools/internal-audit.mjs --snapshot tools/fixtures/internal-audit/snapshot.sample.json --skip gmail,drive,discord,admin,web,patterns --state-dir /tmp/ia-example --out /tmp/ia-sample.md
node --test tools/internal-audit.test.mjs tools/lib/internal-audit/
node --test tools/fraud-audit.test.mjs
```

`--window-days` は既定180、1〜3650。`--min-severity high|medium|info` は表示だけを絞り、件数と `--fail-on-high` の判定は全検出結果を使います。終了コードは正常0、引数・ファイル・通知エラー1、`--fail-on-high` でhighがあれば2です。データソースの取得失敗だけなら0でレポートを残し、未確認データソース節に理由を書きます。

`--skip gmail,drive,discord,admin,web,patterns` はネットワーク取得の除外です。freee は除外不可。snapshot 再実行ではfreee/Gmail/Drive/Discord/Adminは呼ばず、保存時の形跡と外部共有結果を再評価します。**snapshot に検証済みの0件が保存されていると、skip指定でもR02が再現します**。snapshotの対象期間が正本で、`--window-days` の併用は禁止です。Webと候補更新はskipしなければ動きます。再実行は支払い・共有・監査ログの基準時刻を進めません。

既定の状態ディレクトリは `~/.claude/internal-audit`。`--state-dir <dir>` で変更できます。ディレクトリ700、出力ファイル600を設定します。Windows/DrvFSではACLの継承にも注意し、kimのみが読める場所を使用してください。state-dir外に書けないサンドボックスでは、リポジトリ配下の非コミット領域を指定します。

| ファイル | 内容 |
|---|---|
| state.json | 最終実行時刻、既知取引先、外部共有権限の指紋、OAuthアプリ、既知公開URL、ソース別監査ログ取得時刻 |
| reports/YYYY-MM-DD.md | 毎回必ず保存するレポート。同日再実行は置換。重大度別の表は超過案内を含め200行まで |
| reports/YYYY-MM-DD.findings.jsonl | 全検出結果（600）。超過分も含む |
| footprint-cache.json | 取引先ID+年月。検索語・期間が同じ場合30日有効 |
| discord-cache.json | fallbackで走査した90日の範囲・時刻・語別件数。本文を保存しない |
| pattern-candidates.jsonl | 名前正規化で重複を除いた候補。自動ルール化はしない |
| run.lock | pid・開始時刻を保存。pid停止または更新から3時間超で自己回復し、レポートに記録 |

`--json` のsnapshotは、生のAPI応答を保存しません。支払先・決済・口座明細の必要フィールド、マスク済み口座、取得範囲、形跡メタデータのみです。同一口座判定にはsnapshotごとのランダム鍵HMACを使い、鍵と口座番号全桁は保存しません。メール本文・認証秘密も保存しません。

## 接続と読み取り専用境界

freee company_id は11975741。リポジトリ `.env.local` の `PURCHASING_APP_DATABASE_URL` または同名環境変数を使用します。購買部の `freee_tokens` から有効な保存済みアクセストークンをSELECTします。**監査自身はOAuth refreshやDB UPDATEを実行しません**。期限切れならfreeeを未接続としてレポートに記録します。購買部アプリの正規の認証更新後に再実行してください。週次無人運転には、そのアプリ側でのトークン維持が前提です。

freee APIはGETのみ。429/5xxに最大5回再試行し、Retry-Afterを尊重します。支払いは `deals.payments`、日付はpayments.dateです。R15比較のため対象期間とは別に当月前6か月を取得します。経費一覧はissue_dateで絞るため、それより古い取引の後日決済は対象外です。実レスポンスにcreated_atはなく、初回R01は未照合になります。partners一覧に銀行口座・name_kana・emailが含まれます。walletables/account_itemsは全件型マスタとして1回取得します。

Google鍵は `GOOGLE_SA_KEY`、未指定ならWindowsユーザーディレクトリ（WSLでは `/mnt/c/Users/uers`）の `Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json`。Gmailはreadonly、Driveは既存DWD許可に合わせたフルdriveスコープですが、GETだけを実行します。kim/seisaku-team/cr の順に検索します。satou/eigyou/keiri2 は既知の権限制限のため試行せず「未照合」。Gmailは各ユーザーのmessages.list先頭100件の実件数を合算し、100件到達時は「+」を付けます（ユーザー間の重複あり）。resultSizeEstimateは使いません。代表件名は検索完全句が件名またはFromに含まれるメールを優先します。Driveは件数とファイル名のみを残します。旧Gmailキャッシュは再取得抑制のため期限内は再利用しますが、推定件数は未確認とし、R02の0件根拠には使いません。

DiscordのBotは `DISCORD_BOT_TOKEN` または同ユーザーの `.claude/orgiast-discord-bot-token.txt`。検索GETが403/404なら閲覧可能なテキスト・告知チャンネルの直近90日を走査します。スレッドや未参加チャンネルは保証しないため、fallbackの0件は未照合。guild members GETでメンバー名を照合しますが、Discordの所属は雇用関係の証明にならず、メールアドレスも返りません。

形跡照合は支払実績のある取引先を並列度3で処理します。法人格と空白を正規化した名前の完全句を使い、語をOR分割しません。`generic_partner_names` の汎用名自体は形跡照合の対象外とし、決済ごとの実名候補を解決してから照合します（下記）。同じ検索方法で少なくとも1取引先に正の形跡が得られないソースでは、0件を確定しません。3ソースすべてが取得成功・対照確認済み・0件の場合だけR02を出します。検索範囲外のアカウントに仕事の記録がある可能性は残ります。

## Workspace 監査ログの権限

未許可なら `unauthorized_client` を検知し、「未確認」として次回まで待機します。Google管理コンソール（**kim@orgiast.jp** で開く）→ セキュリティ → アクセスとデータ管理 → APIの制御 → ドメイン全体の委任 → `sheets-sa.json` の `client_id` を編集 → 次のスコープを追加 → 承認。

```text
https://www.googleapis.com/auth/admin.reports.audit.readonly
```

レポートには鍵から読んだclient_idを埋め込みます。private_keyは出しません。付与後は次回実行から自動で有効。drive/login/tokenをページング取得し、download/export、外部共有変更、疑わしいログイン、新規OAuth付与を集計します。初回30日、以降は成功したソース別の前回時刻と7日前の早い方から取得し、週をまたぐ大量downloadを検出します。閲覧イベントをdownloadと混同しません。モバイル・退職者人事連携はV1未対応です。

## ルールと誤検知

金額・日数・件数は `tools/internal-audit-patterns.json` の `thresholds` が正本です。

| ID | 既定の判定 | 主な誤検知・制約 |
|---|---|---|
| R01 | 未知業者の初回支払60日以内、合計10万円以上 | 新規の正当な仕入れ。初回にcreated_atなしなら未照合 |
| R02 | 全ソース形跡0。30万円以上high、未満medium | 別アカウント、旧商号、表記揺れ。失敗・skipは未照合 |
| R03 | 30万円以上で10万円の倍数 | 固定料金・定額契約 |
| R04 | 承認閾値10/30/50/100万円の90%以上100%未満。3回以上medium | 定価、値引き |
| R05 | 同一取引先・同額で14日以内 | 分納、同額の定期支払 |
| R06 | 異なる業者の銀行・支店・全口座番号が同じ | 収納代行、グループ口座 |
| R07 | カナ名義不一致かつ10万円以上 | `payment_agents` に正規化名義が部分一致すれば「収納代行経由」info。カナなしで比較不能ならinfo |
| R08 | 法人名なのに名義に法人略号がない | 収納代行は対象外。R13-high一致時は相互参照 |
| R09 | 同一業者7日以内3件以上、合計10万円以上 | 分割納品、合算精算 |
| R10 | 30日以上未消込5万円以上。無視10万円以上はinfo | 消込遅れ、重複明細の正当な除外 |
| R11 | 支払日が土日または収録祝日 | 予約処理日・自動引落。時刻は不明 |
| R12 | 200件以上で先頭桁χ²>15.5 | 固定価格帯。統計的偏りは不正の証明ではない |
| R13 | 法人格のない取引先名・メール一致はmedium。法人の個人名義口座とメンバー名一致はhigh | 業務委託・同姓同名・ゲストの可能性。Discord一致だけで社員とは確定しない |
| R14 | フリーメールの業者 | 個人事業者 |
| R15 | 当月30万円以上かつ過去6か月平均の3倍超 | 季節性、新規案件。未完了月と月平均の比較 |
| exfil | ベースライン完了後の新規外部宛共有high、anyoneはmedium | 初回・ユーザー別走査未完了時はinfo 1件とドメイン集計。所有ユーザーをリンクに併記 |
| exfil-admin | 24時間20件/7日50件download/export、外部共有変更、新OAuth | 正当なバックアップ・移行。初回ログは既存アプリも含む |
| leak-search | 公開検索をLLMでyes/no/unsure。yes high、unsure info | 公開情報・同名企業・検索要約誤り。リンク先を人手確認 |

`allowlist_partners` にfreee取引先ID（文字列）を追加すると、その業者のR02/R07/R08だけを抑制します。他ルールは残ります。許可前に根拠を確認し、不要になったIDは削除します。キャッシュによる古い判断を避けるには、対応するfootprint-cacheエントリを削除して再取得します。

パターン定義は[ACFEの職業上の不正分類](https://www.acfe.com/fraud-resources/fraud-101-what-is-fraud)を基に24件を収録し、情報持ち出しを追加しています。給与・経費証憑・在庫・人事等の未接続データは未ルール化と明記します。2026年の祝日は[内閣府の祝日一覧](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html)から収録。翌年分は定義ファイルを更新してください。

## 公開検索と候補更新

Web検索は既存 `web-search.mjs --json`、分類・抽出は `llm-ask.mjs --provider deepseek --no-fallback`。Claudeや別プロバイダへの自動切替はしません。子プロセスはshell:false、120秒上限。全体28分のネットワーク予算を設け、期限後は未確認としてレポートを保存します。公開検索結果だけをLLMへ渡し、支払い情報・内部メール等は渡しません。

GEMINI_API_KEY/GROQ_API_KEY/DEEPSEEK_API_KEYを環境変数、またはユーザーディレクトリの既存キー設定から読みます。コスト台帳はstate-dir配下のexecutor-homeへ保存します。検索ごとの引用URLから候補を抽出し、出典URLを入力集合で検証して蓄積します。候補は週次実行時に更新されますが、自動的なルール変更やコード実行はありません。既知の公開URLは再報告せず、分類失敗したURLは次回に再試行します。

## 週次タスクと通知

司令塔がWindowsで次を実行します（Codexは登録・通知・push・PR作成を行いません）。

```powershell
powershell -ExecutionPolicy Bypass -File tools/register-internal-audit-task.ps1
```

`OrgiastInternalAudit`、月曜07:00（Windowsローカル時刻）、最大60分。`node tools/internal-audit.mjs --notify --out <state-dir>/reports/latest.md` を実行します。`--notify` は自社レポート配布のみを例外として、kim@orgiast.jp のMy Drive直下「内部監査レポート」フォルダ（なければ作成）へレポートをアップロードし、`notifyKim` のDMに件数・high先頭5件・所有ユーザー付きDriveリンクを載せます。アップロード失敗時はローカルパスでDMを継続します。webhook fallbackは無効で、チャンネル投稿はしません。監査対象の外部データは変更しません。DM配信失敗はレポート保存後にexit 1。

Admin Reportsのイベント名・外部可視性は[Google公式のDrive監査イベント仕様](https://developers.google.com/workspace/admin/reports/v1/appendix/activity/drive)に対応します。`shared_externally`、`visibility_change=external` を検知し、`change_user_access` の `new_value=none`（解除）は新規外部共有として扱いません。日付・日次レポート名はJSTです。

Web分類は並列度3、1回30URLまでとし、超過分は「未確認」に記録して既知URLには追加しません。候補更新の実行時間を確保するための上限です。

Drive一覧は[公式仕様の上限1000件/ページ](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)で取得し、大量ファイルの走査時間を抑えます。freeeは100件/ページです。

Driveの走査予算は `--drive-budget-seconds`（既定600秒、1〜1680秒）を3ユーザーに均等配分します。まず公開・リンク・ドメイン可視性の別クエリを全ページ走査し、その後に所有ファイル全体を走査します。公開共有の先行走査も時間上限やAPI失敗時は完全取得を主張せず、別カーソルで継続します。

`state.driveScan[user]` と `drivePriorityScan[user]` は `version: 2`、`startedAt`、`completedAt`、`completedCursor`、`modifiedCursor`、`boundaryIds`、`inProgress`、`scannedCount` を保存します。pageTokenは実行内の変数だけに保持し、旧stateの値は破棄します。`orderBy=modifiedTime desc` で取得したページ末尾のmodifiedTimeを毎ページ保存し、次回は `modifiedTime <= modifiedCursor` から再開します。同時刻の取得済みIDは除外し、未取得IDを回収します。同一実行のpageToken使用中はクエリを固定します。HTTP 400ならその実行で1回だけトークンを捨て、保存カーソルから即座に再開します。全ページ完了時にcompletedAtを記録し、走査開始時刻をcompletedCursorに保存、以降は `modifiedTime > completedCursor` かつ今回の開始時刻以下の差分を取得します。未完了の所有ファイル走査を再開する際は、完了済み先行走査の次の差分を後回しにします。未完了ユーザーのファイル単位警告は保留します。

初回（`knownExternalShares`なし）と未完了走査はベースライン構築中です。集計は所有者×anyone/外部ドメイン×ドメインの権限数で、上位30ドメインと残余を表示します。差分走査は削除・所有者変更を追跡しないため、現状表は各ファイルを最後に確認した時点の集計です。旧snapshotには所有者と再開位置がないため「所有者不明」と表示し、再評価からベースラインを確定しません。

未登録取引先の支払は件数・合計を1行に集約し、`thresholds.unregistered_min`（既定50,000円）以上だけ個別表示します。R15の比較期間不足も1行に集約します。LLMのJSON出力は前置き・フェンスを除き括弧を対応させて抽出し、不正なら1回だけ再問い合わせします。再失敗はfailedとして秘密値をマスクした先頭80文字を理由に残します。

`--json` 指定時はfreee取得後と形跡照合後にも `runStatus: incomplete` の途中snapshotを保存します。正常にレポート保存まで進んだsnapshotのみ `runStatus: complete` になります。途中snapshotの再評価は、レポートのデータソース状態で収集未完了と分かります。


## V1.3 汎用取引先の実名解決

`generic_partner_names`（その他・当月払い・アシスタント等）の対象期間内の決済に、同額・日付近傍の候補を次の優先順で付けます。合算振込の金額を個人へ任意配分しません。候補の付与は振込先の確定を意味しません。

| resolved_by | 正本 | 条件・使う名前 |
|---|---|---|
| a | 振込予定一覧【経理部】 `1sqFlqPfYzlQtMPE0r3olyHdeVTtkTdiOefCavUIP0LU` | 決済日±7日・依頼金額一致。「取引先（名前・会社名）」と業務内容を使用 |
| a | ★アップロード用／振込データ（PayPay） `17J0_ahQ4rByhv1jEKL3tRpwFcsM7lV_9Z7_BDhRMNbM` | ±7日・同額。月別履歴の「振込指定日(年/月/日)」「受取人名」「振込金額(円)」、アップロード用の「取引日」「取引内容」「出金額」、楽天履歴の日付・受取人を使用 |
| b | freee wallet_txns | ±5日・同額。半角カナを全角化、法人略号を除去。WEB総振・手数料・名称のない摘要は除外 |
| c | 購買DB purchase_records / cases / users | ±14日・同額。vendor_name（なければitem_name）と作成者名。casesは予算とpurchase_date/complete_at、requester/item_summary。取消案件は除外 |
| d | 購買依頼フォーム `1Uu0bdtI9AnHVJ9325SsbGIEWxl1uk3z8e9jzp0aF2RU` | 「購買依頼フォーム」タブの支払合計金額・対応完了日±14日。依頼者と対応者を使用 |

同一優先ソースに複数の同額候補があれば最も近い日付を選び、`ambiguous: true` と候補数・出典を保存します。曖昧な実名からR02の「形跡なし」は断定しません。どれにも当たらなければunresolvedです。name/emailを正規化して購買DB users・Discordメンバーに一致する人、または業務内容が当月払い・立替経費・給与・社員・アシスタントの場合は「社内の人への支払い」と表示し、形跡照合を省きます。これは名簿・区分による分類であり、雇用関係の証明ではありません。支払請求書や法人名は業者として通常照合し、区分を裏付けられない候補は「区分未確認」と明示して照合します。

SheetsはDWDでkim@orgiast.jpへ委任し、`spreadsheets.readonly`スコープとGETだけを使います。メタデータとヘッダーを確認し、最大500行単位の範囲をbatchGetします。7日間の `payee-sheet-cache.json` は正規化した必要列だけを保持し、銀行口座の生データは保存しません。取得失敗した結果は7日キャッシュにしません。購買DBはpostgresを遅延importし、read-only接続で指定4テーブルの必要列だけをSELECTします。実名解決のDB読取はfreee_tokensに触れません（既存freee認証のSELECTは従来どおり）。

2026-10-23に実物確認したPayPayタブは「アップロード用」「銀行コード一覧」「202609」〜「202603」「楽天履歴」「0917単発」「1005前倒し」。7月は依頼人名と受取人名の並びが他月と逆なのでヘッダーで決定します。銀行コード一覧は照合対象外。年と振込日がない単発・前倒しタブから日付は推測せず、対象外理由を記録します。履歴タブには二重チェック列・業務内容列がないので「未チェック」とは断定しません。R18はその列が実在する振込予定一覧だけに適用します。

アシスタントタスクリスト `13CRscpB6Ks8HTsVvQYJJ66tKcFhyI3Mmpx7yTAzeiGI` の「アシスタント様 一覧」「task済シート」「費用チェックシート」「アシスタント費用実際支払い分」を確認しました。名前・月別集計・タスク予算/締月はありますが、確認した列は実際の個別振込日と振込額の組ではありません。月末を振込日と仮定する照合を避けるため、今回は決済照合には使用しません。

| ルール | 内容 |
|---|---|
| R16 generic-unresolved | unresolvedでthresholds.unregistered_min以上ならmedium、未満は件数・合計を1行のinfoに集約。必要ソースの取得失敗・解決の正の対照がないときは「該当なし」を確定せず未確認。対象外タブを含む全帳簿の不存在は主張しない |
| R17 self-approval | usersのid/name/email正規化でrequesterとself_purchase_approved_byが同一ならmedium。approvalsにcase_idがない10万円以上のpurchase_recordsはinfo。監査期間内の承認・購入のみ |
| R18 double-check-missing | 二重チェック列が実在し値が空、10万円以上、監査期間内の振込予定を月別に件数・合計1行でinfo |

形跡ソースの状態は非汎用名かつ検索語2文字以上でskipでない対象の成功率で決めます。全成功OK、一部失敗は「一部失敗（失敗数/対象数 社）」と理由、全失敗は「失敗」。分母0は「未確認（照合対象なし）」です。汎用名・短すぎる語・skipは『形跡照合の対象外』に取引先名・理由・期間合計を出し、取得成功と混ぜません。解決済みの外部支払先は分母に含めます。

『汎用取引先の実名解決』には汎用名別の件数・金額・解決率・a〜d内訳・未解決集計、続いて実名別の区分・件数・金額・形跡結果・出典を表示します。実名表は案内行を含め200行上限。全実名集計と決済単位の候補は `reports/YYYY-MM-DD.payees.jsonl` に保存します。検出結果は従来のfindings.jsonlに全件保存します。

R10は **明細は同期済みだが仕訳が未登録＝経理の未処理** です。detailは「明細あり・取引未登録（freee 消込待ち）: 日付 金額円」。口座別に件数・合計を1行で表示し、個別表示は金額上位10件に限定します。「無視された出金」は区別し、個別全件はfindings.jsonlに残します。

過去の振込予定一覧で銀行名義と実名が一意に対応する場合に限り、その対応表でカナ名義を実名へ補完します。小書きカナ・空白・濁点を正規化し、複数実名に対応する名義は補完しません。過去の支払区分を今回の区分に流用せず、補完後の名前を名簿と照合します。Gmailメタデータ取得は各検索内3並列、完了した取引先から形跡キャッシュを直列保存します。検索期間が違うキャッシュは使いません。

秘密値マスクでは数値のネットワークポート設定（`*_PORT`、1〜65535）を秘密として扱いません。IMAPポートと同じ数字を含むISO時刻のミリ秒を置換すると再開カーソルが壊れるためです。実際の認証値は引き続きマスクします。過去に破損した日時をstateから読んだ場合はAPIに渡さず、完了扱いを取り消して保守的にベースラインを取り直します。
