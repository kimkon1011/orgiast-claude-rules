# 212coffee 業務チェック

出勤時（開店準備）と退勤時（閉店作業）のチェックを、スマートフォンから記録する小さな Web アプリです。閉店作業の「ルンバの裏側清掃」は、写真を添付するまでチェックできません。

## 起動方法

ES Modules を使うため、リポジトリのルートで次を実行し、ブラウザで `http://localhost:8000/apps/cafe-ops/` を開きます。

```sh
python3 -m http.server 8000
```

テストは Node.js 18 以上で実行します。依存パッケージのインストールは不要です。

```sh
node --test apps/cafe-ops/test/cafe-ops.test.mjs
```

送信内容はブラウザの `localStorage` にある `cafe-ops-submissions` へ保存します。

## チェック項目について

現在の項目は動作確認用の最小限のシードです。正式な項目一覧は、Google フォーム「カフェ オープン前 チェックリスト」（ID `1rTaqIMkw3mFv5S04E-e_Gi5JTaAeGrZ4v95-1eh2fbM`）と Google Sites「カフェマニュアル」から反映します。未確認の項目を推測で追加していません。

## 未実装・次にやること

- Google フォームと Google Sites を確認し、正式な開店・閉店項目へ置き換える
- 通知先の仕様と安全な認証方法を決め、Discord または LINE 通知を実装する
- 現在空の `WEBHOOK_URL` を、安全なサーバー側設定から取得する形に変更する

現時点では Discord / LINE 通知は未実装です。`WEBHOOK_URL` が空のため、画面には「通知先が未設定のため保存のみ」と表示されます。
