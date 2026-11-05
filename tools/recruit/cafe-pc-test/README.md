# カフェスタッフ応募者向け PC事務テスト

架空の学会情報をルールどおりに表へ整理できるかを、Excelファイルで確認するテストです。受験時間は60分が目安です。

## 準備と配布

このディレクトリで依存関係を導入し、配布用ファイルを生成します。

```powershell
npm install
node build-test.mjs
```

生成された `cafe-pc-test.xlsx` だけを受験者へ渡します。受験者には「作業」シートへ入力し、保存したファイルを提出してもらいます。`answer-key.json` は採点者だけが保管してください。

## 採点

```powershell
node grade.mjs C:\path\to\提出.xlsx
```

合計点、満点、合否、セルごとの誤り・期待値・入力値・該当ルールが表示されます。既定の合格ラインは85%です。

```powershell
node grade.mjs C:\path\to\提出.xlsx --pass 0.90
node grade.mjs C:\path\to\提出.xlsx --json
```

`--pass` は0～1で変更できます。`--json` は他の処理へ渡しやすいJSONを出力します。重複欄は1セル8点、その他は1～3点で、重複の見落としを大きく減点します。

## 動作確認

```powershell
node --test test/
```

正解、空欄、典型的なミス、減点しない表記ゆれを自動確認します。
