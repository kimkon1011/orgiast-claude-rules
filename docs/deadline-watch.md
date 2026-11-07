# 期限台帳

期限のある義務を Gmail・Drive・LINE・Discord の既存取込から検出し、Google スプレッドシート「期限台帳」を正本として毎朝追跡する。通知は kim-inbox の期限レーンと朝のまとめ、kim のカレンダーに届ける。検出処理は Gemini → OpenRouter（openai/gpt-oss-120b）だけを使い、各プロバイダの自動フォールバックを無効化する。

## 初期化と設定

```sh
node tools/deadline-ledger.mjs --init
```

DWD で kim@orgiast.jp として作成し、「期限台帳」「候補」「使い方」の3タブを用意する。seisaku-team@orgiast.jp と cr@orgiast.jp に編集権限を付ける。共有通知メールは送らない。作成直後に sheetId を保存し、共有などで途中失敗しても再実行で同じ台帳を使う。

設定・状態の置き場は `ORGIAST_HOME`（未指定ならユーザーのホーム）の `.claude/deadline-watch/`。

| ファイル | 内容 |
| --- | --- |
| config.json | sheetId、mailboxes、driveUsers、lineSheets、vehicleSheetId、kimNames、calendar |
| seeds.json | 初期義務の配列。未配置ならスキップ。英語フィールドまたは台帳の日本語列名で指定 |
| state.json | 入力源別の透かし・ページカーソル・日次件数、カレンダー停止、車検通知日 |
| detect-log.jsonl | 追加件数、候補件数、処理エラー、登録したID |
| digest.json | 直近の朝まとめ（診断用。配達時は正本を読み直す） |

初期値は kim@ / seisaku-team@ のメールとDrive、指定された2冊のLINE履歴、車検台帳。カレンダーは kim@orgiast.jp。設定の `calendar.enabled` で同期を切れる。`seeds.json` は `title` / `kind` / `due` / `sourceId` 等を指定し、最低限 `title` と `sourceId` が必要。期限不明の種は候補へ置く。繰り返し初期化しても重複しない。

## 列

両タブの列順は共通。A〜Q、値の書込みはすべて RAW。

| 列 | 意味 |
| --- | --- |
| ID | D-001からの連番。候補も同じ連番を消費し、承認後も維持 |
| 件名 | 義務の短い名前 |
| 種別 | 車検／訴訟・法務／行政・消防／補助金・申請／契約更新／支払／回答・返信／提出／その他 |
| 会社 | 関連会社 |
| 期限日 | YYYY-MM-DD。候補は空欄可 |
| 残日数 | 毎朝計算。延期中は備考の延期先から計算 |
| 状態 | 候補／未着手／対応中／完了／不要／延期 |
| 担当 | 既定は支払=経理、その他=kim。本文で確認できる宛名を優先 |
| やること | 次の具体的な対応 |
| 根拠 | 原文引用と元資料URL |
| 出典 | Gmail／Drive／LINE／Discord／車検台帳 |
| 出典ID | メール箱とメッセージID等の識別子。完了・不要でも再登録しない |
| 検出日 | 検出時刻。GmailのSENT判定基準にも使う |
| 最終通知日 | kimへの通知日。同日再実行の重複計数防止 |
| 通知回数 | 新たな段階通知の回数。inbox表示・置換では加算しない |
| 完了日 | 完了確認日。支払はこの列の入力で自動完了 |
| 備考 | 抽出確信度・Gmailスレッド情報のJSON（先頭行）、延期先、手動メモ |

## 検出と候補

```sh
node tools/deadline-detect.mjs
node tools/deadline-detect.mjs --dry-run --fixture tools/fixtures/deadline/
```

Gmailは各箱80通/日まで、件名とsnippetで期限関連語を選別してから本文を取る。GitHub、fleet-mail、Claude報告、noreplyの自動返信を除く。Driveは各ユーザー50ファイル/日まで。Docsをテキストexportし、PDF・画像はOCR用のコピーをDocs化してexport後に削除する。読む本文は30KBまで。LINEは `Messages!A:G` の `ts`、Discordは `discord-inbox-state.json` を入口として既存の `pending-decisions.jsonl` に保存された取込本文を読む。新たなDiscord取得・投稿は行わない。

源ごとに10件単位で抽出。明日・1週間以内などは送信日を日本時間にして絶対日へ直す。引用が原文にない応答はエラー、日付の裏付けがない応答は候補に留める。年の省略などを解決できない場合も候補で確認する。確信度0.8以上かつ根拠のある期限は未着手へ、法務・行政・補助金または確信度0.5以上は候補へ。候補増加のお知らせは日ごとにinfo 1件だけ。

出典ID一致、または正規化した件名一致かつ期限差2日以内なら重複。完了・不要も照合対象。源の取得・抽出・追記が成功するまでその源の透かしを進めない。ページ上限ではカーソルを保存して次の日に続ける。別の源は処理を続け、失敗をJSONに残して終了コード1にする。

実データの `--dry-run` も台帳・状態・inbox・カレンダーを書き換えない。PDF・画像のOCRコピー作成は省略する。フィクスチャのdry-runはネットワークも鍵も不要。

## 状態と会話での操作

候補 → 承認 → 未着手 → 対応中 → 完了。不要なものは不要、期限変更は延期。候補は期限を確認して入力してから承認する。期限空欄の候補は一括承認でも候補に残る。移した候補行は監査用に完了として残す。不要の候補は候補タブの状態を「不要」に変更する。

```sh
node tools/deadline-watch.mjs --done D-003 --note '振込控えを確認'
node tools/deadline-watch.mjs --defer D-003 --until 2026-11-20
node tools/deadline-watch.mjs --drop D-003
node tools/deadline-watch.mjs --approve 2
node tools/deadline-watch.mjs --approve 全部
```

会話では「D-003 完了」「D-003 延期 11/20」「D-003 不要」でよい。アシスタントが年月日を確認して上のコマンドを実行する。操作後は台帳と該当inboxを更新する。延期先は備考の `延期先: YYYY-MM-DD` に記録。Gmailメタデータの先頭行は保持する。

自動完了は、回答・返信の同じGmailスレッドに検出後のSENTがある場合、支払の完了日が入った場合。車検の完了・売却は車検台帳に従う。車検台帳は期限追跡からは読み取り専用で、V01等のIDをそのまま使い、更新操作は車検台帳で行う。

Gmailの完了照合に失敗した行は未完了として期限通知を続ける。照合エラーはJSONの `errors` に `phase: auto-close` として残し、終了コード1・heartbeat失敗で再試行対象にする。証拠を取得できないことを完了扱いにしない。

## 毎朝の追跡

```sh
node tools/deadline-watch.mjs
node tools/deadline-watch.mjs --digest
node tools/deadline-watch.mjs --dry-run --now 2026-11-04 --fixture tools/fixtures/deadline/ledger.json
```

| 種別・状態 | 通知する残日数 |
| --- | --- |
| 既定 | 30,14,7,3,1,0 |
| 訴訟・法務 | 30,14,7,3,2,1,0 |
| 契約更新 | 60,30,14,7,1,0 |
| 支払 | 7,3,1,0 |
| 回答・返信 | 3,1,0 |
| 対応中 | 3,1,0（種別より優先） |
| 超過 | 毎日 |
| 完了・不要 | 通知しない。既存inboxを閉じる |

担当が `kimNames` の人、または残り3日以内ならkimへ。それ以外も正本と「今週の期限」（超過・14日以内、担当付き）には表示する。赤は超過・3日以内、橙は14日以内、黄はそれ以外。既存の期限項目は毎朝本文・期限を更新する。

kim-inboxは期限を先頭・残日数順・最大5行・各140字で表示。残った文字数予算でask/infoを表示し、全体1800字を守る。期限がないときの既存の進捗優先処理は維持する。`--key` はopenな期限を置換し、`--close-key` は期限だけを閉じる。車検watchも同じキーを使い、同車の旧askは期限への移行成功後に閉じる。

## カレンダーと監視

未着手・対応中・延期の有効な期限を終日予定 `【期限】件名` としてupsert。7日前・1日前のpopup、説明に台帳URL。`extendedProperties.private.deadlineId` と決定的なイベントIDで重複を防ぐ。完了・不要は次の追跡時に予定を削除する。403では一度だけログを出し、`state.json` の `calendarSync:false` で以後停止する。権限修復を検証した担当者がこの値を削除した場合に再開する。

毎回ローカルheartbeatを記録し、`logs/deadline-detect.log` / `logs/deadline-watch.log` とタスク結果で稼働確認する。ヘルス期待は36時間。部分失敗も成功扱いにせず終了コード1。初回は `LastRunTime` と `LastTaskResult`、heartbeatの `ok` を合わせて確認する。

## 登録と配布

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/register-deadline-watch-tasks.ps1 -Ensure
```

OrgiastDeadlineDetect（02:40）とOrgiastDeadlineWatch（08:30）を同期済みmainから起動する。wscript → run-hidden.vbs → node、同時起動はIgnoreNew。`lib/kim-operated.mjs` が認めるkim席だけで登録し、他の席はno-op。`-DryRun`、`-ValidateOnly`、`-Unregister` 対応。`setup.mjs --converge` と `register-nightly-tools.ps1` から同じ登録処理を呼ぶ。登録後はアクションと時刻を再読込して照合する。

本番の `--init`、登録、通知を伴う実行は、指定された後続の検証セッションで行う。この実装セッションはフィクスチャ・依存注入のテストのみ。

## ノイズの停止と初回掃除

fleet-mail-watchdogの未達・未読はfleet-chase台帳の `deliveryAlerts` に記録し、記録成功後に受領確認する。kimには送らない。fleet-chaseの通知対象も判断カテゴリに絞る。gate-reportのinfoは入口でも抑止。

初回の検証セッションで実行する（この実装セッションでは実行しない）。

```sh
node tools/kim-inbox.mjs --seen-matching "送った連絡が(届いて|読まれて)" --kind info
node tools/kim-inbox.mjs --seen-matching "^gate-report" --kind info
```

正規表現は本文とsourceに適用し、infoだけを既読化する。askや期限には触れない。

## 検証

```sh
node --test tools/*.test.mjs
node tools/deadline-detect.mjs --dry-run --fixture tools/fixtures/deadline/
node tools/deadline-watch.mjs --dry-run --now 2026-11-04 --fixture tools/fixtures/deadline/ledger.json
```

固定入力は検出5件＋候補1件、追跡はD-001／D-002／D-004／D-006／V01の5通知。ネットワーク、鍵、実PCのホームを使わないテストで確認する。

API根拠: [Driveの変換とOCR](https://developers.google.com/workspace/drive/api/guides/manage-uploads)、[Calendar予定のprivate propertiesと通知](https://developers.google.com/workspace/calendar/api/v3/reference/events)。
