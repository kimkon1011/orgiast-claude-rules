# 社内不正・リスク監査 V1

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
| reports/YYYY-MM-DD.md | 毎回必ず保存するレポート。同日再実行は置換 |
| footprint-cache.json | 取引先ID+年月。検索語・期間が同じ場合30日有効 |
| discord-cache.json | fallbackで走査した90日の範囲・時刻・語別件数。本文を保存しない |
| pattern-candidates.jsonl | 名前正規化で重複を除いた候補。自動ルール化はしない |
| run.lock | 二重起動防止。強制終了後は実行中プロセスがないことを確認して削除 |

`--json` のsnapshotは、生のAPI応答を保存しません。支払先・決済・口座明細の必要フィールド、マスク済み口座、取得範囲、形跡メタデータのみです。同一口座判定にはsnapshotごとのランダム鍵HMACを使い、鍵と口座番号全桁は保存しません。メール本文・認証秘密も保存しません。

## 接続と読み取り専用境界

freee company_id は11975741。リポジトリ `.env.local` の `PURCHASING_APP_DATABASE_URL` または同名環境変数を使用します。購買部の `freee_tokens` から有効な保存済みアクセストークンをSELECTします。**監査自身はOAuth refreshやDB UPDATEを実行しません**。期限切れならfreeeを未接続としてレポートに記録します。購買部アプリの正規の認証更新後に再実行してください。週次無人運転には、そのアプリ側でのトークン維持が前提です。

freee APIはGETのみ。429/5xxに最大5回再試行し、Retry-Afterを尊重します。支払いは `deals.payments`、日付はpayments.dateです。R15比較のため対象期間とは別に当月前6か月を取得します。経費一覧はissue_dateで絞るため、それより古い取引の後日決済は対象外です。実レスポンスにcreated_atはなく、初回R01は未照合になります。partners一覧に銀行口座・name_kana・emailが含まれます。walletables/account_itemsは全件型マスタとして1回取得します。

Google鍵は `GOOGLE_SA_KEY`、未指定ならWindowsユーザーディレクトリ（WSLでは `/mnt/c/Users/uers`）の `Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json`。Gmailはreadonly、Driveは既存DWD許可に合わせたフルdriveスコープですが、GETだけを実行します。kim/seisaku-team/cr の順に検索します。satou/eigyou/keiri2 は既知の権限制限のため試行せず「未照合」。Gmailは件数推定と最新1件の件名、Driveは件数とファイル名のみを残します。

DiscordのBotは `DISCORD_BOT_TOKEN` または同ユーザーの `.claude/orgiast-discord-bot-token.txt`。検索GETが403/404なら閲覧可能なテキスト・告知チャンネルの直近90日を走査します。スレッドや未参加チャンネルは保証しないため、fallbackの0件は未照合。guild members GETでメンバー名を照合しますが、Discordの所属は雇用関係の証明にならず、メールアドレスも返りません。

形跡照合は支払実績のある取引先を並列度3で処理します。同じ検索方法で少なくとも1取引先に正の形跡が得られないソースでは、0件を確定しません。3ソースすべてが取得成功・対照確認済み・0件の場合だけR02を出します。検索範囲外のアカウントに仕事の記録がある可能性は残ります。

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
| R07 | カナ名義不一致かつ10万円以上 | 屋号・名義略称。カナなしで比較不能ならinfo |
| R08 | 法人名なのに名義に法人略号がない | 代表者名義口座、登録不備 |
| R09 | 同一業者7日以内3件以上、合計10万円以上 | 分割納品、合算精算 |
| R10 | 30日以上未消込5万円以上。無視10万円以上はinfo | 消込遅れ、重複明細の正当な除外 |
| R11 | 支払日が土日または収録祝日 | 予約処理日・自動引落。時刻は不明 |
| R12 | 200件以上で先頭桁χ²>15.5 | 固定価格帯。統計的偏りは不正の証明ではない |
| R13 | 業者名・カナ名義・メールとDiscord名簿が一致 | 同姓同名、業務委託、ゲスト。メールはAPI未提供 |
| R14 | フリーメールの業者 | 個人事業者 |
| R15 | 当月30万円以上かつ過去6か月平均の3倍超 | 季節性、新規案件。未完了月と月平均の比較 |
| exfil | 新規外部宛共有high、anyoneはmedium、既知はinfo集計 | 正当な顧客・取引先共有。初回は既存共有も新規検出 |
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

`OrgiastInternalAudit`、月曜07:00（Windowsローカル時刻）、最大60分。`node tools/internal-audit.mjs --notify --out <state-dir>/reports/latest.md` を実行します。`--notify` だけが外部送信を許可し、`notifyKim` のDMに件数・high先頭5件・ローカルレポートパスを載せます。webhook fallbackは無効で、チャンネル投稿はしません。Google書き込み禁止を守るためDriveアップロードは実装しません。DM配信失敗はレポート保存後にexit 1。

Admin Reportsのイベント名・外部可視性は[Google公式のDrive監査イベント仕様](https://developers.google.com/workspace/admin/reports/v1/appendix/activity/drive)に対応します。`shared_externally`、`visibility_change=external` を検知し、`change_user_access` の `new_value=none`（解除）は新規外部共有として扱いません。日付・日次レポート名はJSTです。

Web分類は並列度3、1回30URLまでとし、超過分は「未確認」に記録して既知URLには追加しません。候補更新の実行時間を確保するための上限です。

Drive一覧は[公式仕様の上限1000件/ページ](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)で取得し、大量ファイルの走査時間を抑えます。freeeは100件/ページです。

大量のDriveファイルが他の監査面を止めないよう、所有者ごとの走査は120秒を上限とし、直近更新順に取得します。未走査ページが残る場合は、件数と「部分取得」を必ず未確認データソースへ記録します。**全Driveファイルを監査したとの意味ではありません**。V1には長期間のページング継続機能はなく、毎回直近更新順から開始するため、大規模Driveの古いファイルには継続的な未走査範囲が残ります。Workspace監査ログの権限付与も併せて実施してください。

`--json` 指定時はfreee取得後と形跡照合後にも `runStatus: incomplete` の途中snapshotを保存します。正常にレポート保存まで進んだsnapshotのみ `runStatus: complete` になります。途中snapshotの再評価は、レポートのデータソース状態で収集未完了と分かります。
