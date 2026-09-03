# 全社標準 GAS 不具合・要望フォーム

Google Apps Script（GAS）で作った社内アプリへ、不具合・要望フォームと Discord 通知を導入する標準パッケージです。追加ライブラリは不要で、`templates/` の2ファイルをコピーするだけで動きます。

- `templates/FeedbackRelay.js` — 中継クライアント + 未認証フォームの受け口（サーバー側）
- `templates/FeedbackForm.html` — 報告フォーム本体（クライアント側）

導入手順は非エンジニア向けの手順込みで [INSTALL.md](./INSTALL.md) を参照してください。

## 通知の流れ

1. 対象アプリの Web アプリ URL に `?form=feedback` を付けて開く（ログイン・token 不要）
2. フォーム送信 → 記録先スプレッドシートの「不具合要望」シートに append → 読み戻して照合
3. 記録成功後、全社共通の中継 (`FEEDBACK_RELAY_URL`) へ通知 → 中継失敗時のみ `DISCORD_FEEDBACK_WEBHOOK` にフォールバック
4. 通知が失敗しても記録（②）は成功として扱う（通知は best-effort）

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

このリポジトリは public のため、URL・シークレット・Webhook 等の値はコード中に一切書きません。`Admin_setFeedbackRelay(url, secret, appName, formUrl)` を GAS エディタか clasp 経由で1回実行して Script Properties に保存します。詳細は [INSTALL.md](./INSTALL.md) の手順5。

## 関連パッケージ

Next.js アプリ向けの同等パッケージは [`packages/feedback-widget`](../feedback-widget) です（本パッケージとは独立、互いに依存しません）。
