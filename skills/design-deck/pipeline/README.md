# ハイブリッド企画書パイプライン（配布版）

`media-kit-node/deck-hybrid/` で社長承認された v4 パイプラインの汎用版。文字・数字は HTML/CSS、写真ビジュアルだけを Gemini で生成し、Genspark は配置参照に限定する。

## 導入

1. この `pipeline/` を対象プロジェクトの `deck-hybrid/` へコピーする。
2. `pages.example.json` を `pages.json` にコピーし、原稿と画像パスを書き換える。画像パスは `deck-hybrid/` 基準の相対パスにする。
3. 必要なら `deck.config.json` を作り、`title`, `genImage`, `htmlToPdf`, `playwright` を上書きする。
4. 対象プロジェクトの親ディレクトリに既存の `gen-image.mjs` と `html-to-pdf.mjs` を置く。これらは認証・PDF化の既存許可済み経路であり、この配布版には同梱しない。
5. プロジェクトで解決できる `playwright-core` と Chrome を用意する。

```json
{
  "title": "提案書_v1",
  "genImage": "../gen-image.mjs",
  "htmlToPdf": "../html-to-pdf.mjs",
  "playwright": "playwright-core"
}
```

## 実行

```sh
node deck-hybrid/gen-visuals.mjs
node deck-hybrid/build.mjs
node deck-hybrid/preview.mjs
```

画像だけ再生成するときは `gen-visuals.mjs --force`。文字・数字・表だけの修正では画像生成を再実行せず、build と preview だけを実行する。

出力は `out/<title>.html`, `out/<title>.pdf`, `out/preview-pNN.png`, `out/build-checks.json`, `out/preview-checks.json`。全 PNG を Read で目視し、写真・余白・文字量・数字・一貫性を各5点で採点する。3点以下があれば修正して全ページを再確認する。

## 固定ルール

- 1ページ1メッセージ、見出し14字以内、本文3行以内、重要数字96px級、外側余白96px以上。
- 写真ページは写真面積40%以上。写真を暗くせず、小さな飾り写真にしない。
- Gemini は実写真2〜4枚から、文字・ロゴ・数字・表・図解なしの16:9ビジュアルだけを作る。顔の重複、設営中、床のゴミ・資材、私的集合写真、まばらな会場は禁止。
- 社長提供パースがあれば `perspective` の `directVisual` で直接表示し、Gemini に渡さない。
- Drive の既存ファイルを更新するときは file ID に PATCH し、共有 URL を変えない。kim への URL は `?authuser=kim@orgiast.jp` 付きにする。

写真の不満は素材または `visualBrief` を直して Gemini で再合成する。文字・数字・表・余白の不満は `pages.json` / `styles.css` を直す。
