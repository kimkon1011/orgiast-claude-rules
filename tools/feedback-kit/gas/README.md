# 全社標準 GAS 不具合・要望フォーム

Google Apps Script（GAS）で作った社内アプリへ、不具合・要望フォームと Discord 通知を導入する標準パッケージです。追加ライブラリは不要で、`templates/` の2ファイルをコピーするだけで動きます。

- `templates/FeedbackRelay.js` — 中継クライアント + 未認証フォームの受け口（サーバー側）
- `templates/FeedbackForm.html` — 報告フォーム本体（クライアント側）

導入手順は非エンジニア向けの手順込みで [INSTALL.md](./INSTALL.md) を参照してください。

## 通知の流れ

1. 対象アプリの Web アプリ URL に `?form=feedback` を付けて開く（ログイン・token 不要）
2. フォーム送信 → 記録先スプレッドシートの「不具合要望」シートに append → 読み戻して照合
3. 記録成功後、中継が kim + 開発者へ DM → 中継失敗時のみ Bot DM、webhook の順でフォールバック
4. 通知が失敗しても記録（②）は成功として扱う（通知は best-effort）
5. Issue closed 後、夜間ジョブが投稿者へ完了 DM

## 記録先の決め方

記録先スプレッドシートは次の優先順位で決まります。

1. `FeedbackRelay_submitFromForm` の payload に `logSpreadsheetId` / `logSheetName` を渡す（呼び出し側指定）
2. Script Property `FEEDBACK_LOG_SS_ID` / `FEEDBACK_LOG_SHEET_NAME`
3. どちらも無ければ、そのスクリプトのアクティブなスプレッドシート（コンテナバインドのスクリプトのみ）にシート名 `不具合要望` を自動作成

## 濫用対策（常時有効）

- honeypot（`company` 欄。人間には見えない。埋まっていたら成功を装って破棄）
- レート制限（CacheService で 10 分あたり 5 件）
- 文字数上限（タイトル 200 字 / 本文 4000 字、超過分は切り詰め）
- 画像上限（1 枚 8MB・合計 25MB・5 枚まで。超過分は保存はするが通知には載せない）

## 設定はすべて Script Properties

| Script Property | 用途 | 必須条件 |
|---|---|---|
| `FEEDBACK_OWNER_DISCORD_ID` | kim と併せて投稿通知を送る開発者の Discord user ID | 標準通知を使う全アプリで必須（17〜20桁） |

このリポジトリは public のため、URL・シークレット・Webhook 等の値はコード中に一切書きません。`Admin_setFeedbackRelay(url, secret, appName, formUrl, ownerDiscordId)` を GAS エディタか clasp 経由で1回実行して Script Properties に保存します。`FEEDBACK_OWNER_DISCORD_ID` は投稿時に kim と併せて DM する開発者ID（17〜20桁）で、標準通知を使う全アプリで必須です。詳細は [INSTALL.md](./INSTALL.md) の手順5。

## 関連パッケージ

Next.js アプリ向けの同等パッケージは [`tools/feedback-kit/widget`](../widget/README.md) です（本パッケージとは独立、互いに依存しません）。

## 送信内容・対応状況の閲覧（1.1.0以降の必須機能）

フォームと送信完了表示に「送信した内容・対応状況を見る」リンク（`data-feedback-history-link`）を表示します。Script Properties の `FEEDBACK_HISTORY_URL`（HTTPS）があればそれを使い、未設定なら既存の記録先シートの一覧URLへ進みます。列「日時・種別・タイトル・内容・状態」で投稿と対応状況を確認できます。状態は new（未対応）／in_progress（対応中）／done（完了）など、既存の運用と同じ値です。

Google の既存のシート閲覧権限でアクセスを制御します。投稿者には閲覧者権限で共有し、秘密情報・内部メモを含む管理シートを共有せず、必要なら送信者向けの読み取り専用一覧を作り `FEEDBACK_HISTORY_URL` に指定してください。共有権限はインストーラーでは変更しません。payloadで記録先を上書きするアプリや複数アプリ共用シートでは、対象の一覧をこのプロパティに明示してください。

記録先自体が未設定でもリンクは消えず、アプリ既定の `?view=mine` の案内へ進みます。手動統合では `doGet` の先頭へ `if (params.view === 'mine') return FeedbackRelay_serveHistory();` を追加してください（kit installでは自動追加）。`FEEDBACK_FORM_URL` は当該Webアプリの `/exec` URLを指定します。導入後は投稿者アカウントでフォームと完了表示からリンクを開き、投稿・状態が見えて編集できないことを確認してください。verify はマーカーが無ければ「フォームに送信内容を見るリンクがありません」で不合格になります。
