---
name: design-deck
description: 「提案書」「企画書」「営業資料」「プレゼン」「デッキ」「スライド」「ブースプラン」「パース入り資料」「見せる資料」「デザインして」「かっこよく」など、見た目が評価対象になる資料の作成・修正依頼では必ず使う。学会1枚資料のような定型の量産物・数表主体の実務資料は対象外で、従来の HTML→PDF を使う。
---

# 見せる資料はハイブリッド企画書モデルで作る

Claude が構成・原稿・文字と数字を HTML/CSS で組版し、Gemini 画像モデルが実写真2〜4枚から文字なしの大きな写真ビジュアルを合成する。Genspark AI Slides は写真配置の面積比・余白を学ぶためにレンダを見るだけで、成果物をそのまま採用しない。

パイプラインの実体は `media-kit-node/deck-hybrid/`。別プロジェクトでは `skills/design-deck/pipeline/` を対象プロジェクトへコピーし、`pages.example.json` を `pages.json` にして内容と相対画像パスを書き換える。実制作フォルダを使える場合はその `deck-hybrid/` 全体をコピーして `pages.json` を書き換える。同梱版の依存関係・設定と元版からの差分は [pipeline/README.md](pipeline/README.md) を読む。

## 1. 対象と前提

- 対象: 提案書、企画書、営業資料、プレゼン、デッキ、スライド、ブースプラン、パース入り資料など、見た目が評価対象になる複数ページ資料。
- 対象外: 学会1枚資料のような定型の量産物、数表主体の実務資料。従来の HTML→PDF を使う。
- `deck-hybrid/` の親（対象プロジェクト直下）に、既存の許可済み `gen-image.mjs` と `html-to-pdf.mjs` が必要。Gemini の認証情報を新規コードで直接読まない。
- Genspark は配置参照だけ。文字・数字・表・図解を任せず、成果物をそのまま採用しない。

## 2. 写真素材を集約・選別する

1. Drive の素材フォルダへ写真を集約する。Reブース素材の例はフォルダ ID `1hRRRV2hAXH_cjoFOd_YF0KPFE-xwrIgb`。
2. ファイル名やタグだけで選ばず、全候補を目視する。完成ブース、賑わい、接客・商談、清潔な施工完了写真を選ぶ。
3. まばらな会場、設営・搬入中、床にゴミ・養生材・資材がある写真、社員だけの私的集合写真は使わない。
4. 他社ロゴが大きければモザイクをかける。社長提供パースがある場合は AI パースを作らず、その画像を直接大きく表示する。資料全体のスクリーンショットを拡大しない。
5. 採用素材をプロジェクト内へ置き、`pages.json` からパイプライン基準の相対パスで参照する。

## 3. pages.json を書く

`pages.example.json` をコピーし、全ページに `id / type / kicker / headline / body / footerPage` を書く。見出しは14字以内、導入本文は3行以内を先に守る。

| type | 用途 | 主な追加データ |
|---|---|---|
| `cover` | フルブリード写真と表紙 | `visualBrief`, `photoSources`, `fallbackPhoto`, `subtitle` |
| `stats` | 96px級の数字と写真 | `stats`、必要なら `facts`, `booth`, `cost` |
| `visual` | 大写真と短い説明 | `visualBrief`, `photoSources`, `fallbackPhoto` |
| `table` | 比較表 | `table.headers`, `table.rows`, `insight` |
| `timeline`（配布版追加） | 時系列 | `timeline` |
| `compare`（配布版追加） | 2〜3案の比較 | `columns` |
| `perspective` | 社長提供パースを直接表示 | `directVisual`, `crop`, `points`, `note` |

`timeline`・`compare` は元READMEにはない配布版の追加型。v4由来の `layout-diagram`・`leads-chart`・`finance-table`・`roles-timeline` も維持している（追加データは同梱README）。表セルは `{ text, rowspan?, colspan?, class? }`。`crop` は元画像座標の `x, y, width, height, sourceWidth, sourceHeight` で、表示窓のみを変える。

`visualBrief` は、フルブリードかパネルか、主役と余白の位置、実写真から残す質感を記す。数字・文字・表・図面は書かない。`perspective` に `visualBrief` を併記して Gemini 加工してはいけない。

## 4. Gemini で文字なしビジュアルを作る

```sh
node deck-hybrid/gen-visuals.mjs
```

再生成が必要な場合だけ `--force` を使う（現実装では `visualBrief` のある全ページが対象、ページ選択オプションはない）。`gen-visuals.mjs` は各ページの実写真2〜4枚を `--img` で既存 `gen-image.mjs` に渡す。共通プロンプトは次の型を守る。

> 実写真の質感を保つ。人物は自然で顔の重複なし。文字・ロゴ・数字・表・図解・透かしを描かない。看板・衣服は無地。16:9。明るい会場。施工完了後のブースと自然な接客。設営・搬入・床のゴミ・資材・私的集合写真・まばらな会場は不可。

この共通文に `visualBrief` を続ける。生成画像へ文字や数字を焼き込まず、縦長パネルは16:9画像の中央へ被写体を寄せて HTML 側でクロップする。既存画像は通常スキップする。429は60秒待って1ページ最大3回、回復不能エラーまたは3回失敗なら実写真へフォールバックし、`--force` 失敗時は既存正常画像を維持する。試行・失敗・形式変換は `gen-visuals-log.json` に追記される。JPEGバイトを拡張子だけで失敗扱いにせず、デコードして元解像度でPNGへ変換する。

## 5. Claude が HTML/CSS で組版する

```sh
node deck-hybrid/build.mjs
```

- 1ページ1メッセージ。見出し14字以内、導入本文3行以内。
- 重要な数字は96px級。文字・数字・表・図解は編集可能な HTML/CSS/SVG にする。
- 本文外側余白は96px以上。写真ページの写真面積は40%以上。写真を `filter` や `opacity` で暗くせず、小さな飾り写真にしない。
- 表・図面主体ページは写真を省略してよい。40%未満の小写真と表を競合させない。
- `out/build-checks.json` の14字超・推定3行超の警告を読み、警告を放置せず修正する。

## 6. 全ページを目視する

```sh
node deck-hybrid/preview.mjs
```

全ページを1600×900 PNGへ出力する。Read で原寸の全ページを目視し、各ページを次の5観点で5点満点採点する。

1. 写真の質と内容
2. 余白
3. 文字量
4. 数字の見せ方
5. 全体の一貫性

写真のない図表ページは写真だけ「対象外」とし、採点は `visual-review.json` に記録して `BUILD-REPORT.md` に反映する。元v4の採点を別案件へ流用しない。

1項目でも3点以下なら原因を直し、build→preview→全ページ目視をやり直す。画像デコード、文字切れ、フッター衝突、本文実測行数、写真面積、写真の暗化も `out/preview-checks.json` で確認する。

## 7. PDF と Drive

`build.mjs` は既存 `html-to-pdf.mjs` を呼び PDF 化する。完成 PDF を既存の Drive アップロード経路で保存する。Drive に同名の既存 file ID がある場合は新規作成せず PATCH して URL を不変にする。kim へ渡す URL には `?authuser=kim@orgiast.jp` を付ける。

## 8. 修正を正しい担当へ戻す

- 写真の内容・雰囲気・構図への不満: `visualBrief` または素材を直し、Gemini で再合成する。
- 文字・数字・表・余白への不満: Claude が `pages.json` または CSS を直す。Gemini や Genspark に文字を作らせない。
- Genspark: 写真配置の文法（面積比、写真と文章の分離、余白）の参考としてレンダを見るだけ。
- Canva は使わない。写真投入に公開 URL が必要だが、Genspark の素材 URL は外部から403になり、Drive の公開共有化は auto mode classifier に止められるため、安定した写真投入経路がない。
