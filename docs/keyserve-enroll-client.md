# keyserve: 1行で鍵を導入・復帰する

発行するPCには `~/.claude/keyserve.env` の primary が必要です。サーバの `/api/enroll` と、このクライアントを含む `main` の両方が配布済みになってから利用してください。発行CLIが表示する1行は `main/tools/install-orgiast.ps1` をダウンロードして実行します。

```powershell
node tools/keyserve-enroll.mjs --pc cr-PC --ttl-hours 24 --dm
```

`--dm` は既存の `notify-kim.mjs` で kim に個別送信します。秘密を含むため webhook へのフォールバックは無効です。DM設定がない場合は送信失敗を明示し、画面に表示したコマンドを対象PCの人に個別に渡します。`--dry-run` はダミーのコマンドを作り、発行も送信もしません。`--json` は自動処理向けで、生トークンを含みます。

対象PCの人向けの手順は毎回CLIが全文を出します。スタートから Windows PowerShell を開き、表示された1行をコピーして右クリックで貼り付け、Enterを押します。鍵の復帰成功メッセージを確認した後も、続く通常のセットアップが終わるまで画面を開いておきます。

`-Enroll` は通常のインストーラのリポジトリ取得直後に鍵を同期します。既存PCの日常の鍵同期にも同じ `onboarding-sync.mjs` が使われ、primary → enroll → legacy の順で解決します。鍵一式と primary を保存できた場合だけ enroll.env を削除します。失敗時は夜間バッチを止めません。

インストーラは継承を切った現ユーザーだけのACLを設定してからトークンを書き、`--keys-only --force` で鍵を取得し、保存された primary を `keyserve-status --json` で検証します。既存primaryがHTTP 401だった場合だけ、そのファイルを `keyserve.env.pre-enroll-<一意ID>` に退避して復帰します。通信障害では退避しません。サーバが期限切れを明示しない401は、期限切れと断定しません。

導入結果のDiscord報告にはPC名、authVia、HTTPステータス、成功／失敗だけを含めます。報告の失敗は導入の成功／失敗を変えません。

## 隔離ホームの実環境検証

本物のサーバハンドラをローカルで直接使うE2Eは別リポに依存するためCIでは実行せず、Vercel本番にも通信しません。

```powershell
node tools/keyserve-enroll-e2e.mjs
```

このコマンドはテスト用のprimaryとダミー鍵だけを使い、一時的なローカルHTTPサーバと新PC相当の隔離ホームを作ります。enroll発行、鍵復帰、`enroll.env`削除、2回目のprimary認証、`keyserve-status`まで検証し、終了時に隔離ホームを削除します。サーバリポが既定位置にない場合だけ `ORGIAST_KEYSERVE_REPO` で指定できます。

本番環境を使う従来のWindows検証は次のとおりです。

Windows PowerShell 5.1で、実トークンを受け取ってから次の1行を実行します。

```powershell
& .\tools\keyserve-enroll-e2e.ps1 -Enroll '<受け取った実トークン>'
```

未作成の一時ホームを `ORGIAST_HOME` に設定し、継承された `ORGIAST_KEYSERVE_SECRET` を一時的に外します。実インストーラの `-EnrollOnly` 経路で鍵を取得し、primary / HTTP 200 と enroll.env の削除を再確認します。環境変数は終了時に復元します。検証ホームは結果確認のため残し、その場所を表示します。`-IsolatedHome` で未作成のパスを指定できます。

この検証はローカルの配布コードを使うため、通常インストールの追加ソフト導入や定期タスク登録を実行しません。ダウンロードから始める配布用1行の検証には、この変更をmainへ配布した後の実行が別途必要です。

## 通信しない回帰テスト

```powershell
node --test tools/onboarding-sync.test.mjs tools/keyserve-enroll.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File tools/keyserve-enroll-installer.test.ps1
```

前者はfetchをモックして認証・自己昇格・トークン保持・CLI出力を検証します。後者はNode呼び出しをモックし、Windowsの実ACLとインストーラの成功／失敗分岐を検証します。後者はWindows CIにも登録しています。

## 日本語 hostname のPCでの復帰

発行時の `--pc` は ASCII の fleet ラベル（例: `cr-PC`）です。日本語名は `fleet-pc-map.json` の `sheetName` に書きます。表示された install 一行コマンドは PC 名を引き継ぎ、`-Enroll` 処理で `~/.claude/enroll.env` にトークンと PC 名を書きます。

既存 clone を使う場合は、`~/.claude/enroll.env` に次の2行を保存します（`<token>` は受領したトークンに置換）。

```dotenv
ORGIAST_ENROLL_TOKEN=<token>
ORGIAST_KEYSERVE_PC=cr-PC
```

その後 `node <clone>/tools/onboarding-sync.mjs --force` を実行し、`node <clone>/tools/keyserve-status.mjs` が primary / HTTP 200 と表示することを確認します。成功した PC 名は keyserve.env に保存され、enroll.env の削除後も使えます。

`ORGIAST_KEYSERVE_SECRET` に `ORG1.` で始まるトークンを入れる旧手順は使いません。旧手順で実行された場合は stderr に正しい置き場所を案内し、互換処理で enroll 経路へ回します。通常の primary を持つ場合の primary 優先は維持します。

PC 名は環境変数、既存 keyserve.env の明示設定を優先します。ASCII hostname はそのまま使い、日本語・空の hostname の場合は cost-reporter.env の REPORTER_LABEL、keyserve-pc.txt の順で有効な ASCII 名を探します。決定できなければ API 呼び出し前に明示エラーを出します。
