# ハイブリッド企画書パイプライン（配布版）

実体は `media-kit-node/deck-hybrid/`。以下はそのREADME・v4実装を基にした配布用コピー。`build.mjs` / `preview.mjs` / `styles.css` はv4の組版、クロップ、結合セル、写真面積検査を維持し、案件固有文言とPC固定パスを設定化した。`gen-visuals.mjs` は同じ生成プロンプト・再試行・形式変換を使う。案件固有の写真・図面・生成物・承認結果は配布しない。

## 別プロジェクトへコピーする

1. このフォルダ全体を `<project>/deck-hybrid/` へコピーし、`pages.example.json` を `pages.json` にする。実制作の `media-kit-node/deck-hybrid/` が使える場合はそのフォルダ全体をコピーしてもよい。
2. 原稿と画像パスを書き換える。例の数字はダミー。画像は `deck-hybrid/` からの相対パスで、プロジェクト内に置く。`perspective.crop` は元画像の実寸・選択範囲へ置き換える。
3. `<project>/gen-image.mjs` と `<project>/html-to-pdf.mjs` は外部依存で同梱しない。実制作元 `media-kit-node/` の既存スクリプトを用意するか、`deck.config.json` で既存の場所を指定する。生成CLIは `node gen-image.mjs <output> <prompt> --img <photo> ...`、PDF CLIは `node html-to-pdf.mjs <input.html> <output.pdf>`。認証は既存gen-imageに委ね、新たな鍵読取処理を書かない。
4. Node.js、プロジェクトから解決できる `playwright-core` とChromeが必要。元PDFスクリプトにもこのPC固有のPlaywrightパスがあるため、コピー先での実行環境を確認する。

```json
{
  "title": "企画書_v1",
  "genImage": "../gen-image.mjs",
  "htmlToPdf": "../html-to-pdf.mjs",
  "playwright": "playwright-core",
  "browser": { "channel": "chrome", "headless": true },
  "footerNote": "検討用"
}
```

パス設定は `deck-hybrid/` 基準。`playwright` はモジュール名か絶対パス。`browser` はPlaywright起動設定。任意の `sourceHtml` に元原稿HTMLの相対パスを指定すると全表セル・rowspan・colspanを照合する（省略時は未照合と報告）。配布版はWSLからWindows Nodeへ自動再起動しない。既存gen-imageの認証環境と同じ側のNodeで実行する。

```sh
node deck-hybrid/gen-visuals.mjs
node deck-hybrid/build.mjs
node deck-hybrid/preview.mjs
```

通常は既存画像をスキップ。`--force` は `visualBrief` のある全ページを再生成する。文字・数字・表だけの修正ではbuild→previewだけを実行する。
出力は `out/<title>.html` / `.pdf`、全ページ `out/preview-pNN.png`、`out/preview-index.html`、各検査JSON、`BUILD-REPORT.md`。`report.mjs`・`runtime.mjs`・`styles.css` も必ず一緒にコピーする。

## ページ定義

共通は `id / type / kicker / headline / body / footerPage`。写真生成ページに `visualBrief / photoSources / fallbackPhoto`、数字ページに `stats` を置く。任意の `footerText / footerNote / photoCaption / visualAlt` で案件の文言を指定できる。

| type | 表現 | 必須の追加データ |
|---|---|---|
| `cover` | フルブリード写真＋左下の白い文字面・大見出し | `visualBrief`, `photoSources`, `fallbackPhoto`, `subtitle`, `event`等 |
| `stats` | 左に96pxの数字2〜4個、右に写真パネル | `stats`, `facts`, `booth`, `cost` |
| `visual` | 右60%の写真と左の短い見出し・本文 | 画像情報 |
| `table` | 表主体、必要なら写真帯を検討 | `table.headers`, `table.rows`, `insight` |
| `layout-diagram` | v3 SVG平面図＋96pxの面積と説明 | `svg`, `companyCount`, `area`, `frontWidth`, `features`, `shared`, `note` |
| `perspective` | 社長提供画像を直接 `<img>` で大きく表示 | `directVisual`, `crop`, `points`, `note`。`visualBrief`は禁止 |
| `leads-chart` | v3の棒グラフ・共有プール表＋右の接客写真 | `svg`, `table`, `chartNote`, `poolNote`, `methods`, `reason` |
| `finance-table` | 収支表＋単価・除外費用の注記 | `table`, `formulas`, `note` |
| `roles-timeline` | 役割分担、横4段×2行の時系列、次の行動＋右写真 | `roles`, `timeline`, `actions` |

配布版では指示に合わせて `timeline`（`timeline: [{date, text}]`）と `compare`（`columns: [{title, value, unit, items: []}]`）も追加している。この2型は元v4 READMEの実装ではない。最小の7型例は `pages.example.json` を参照。元版のSVG型を使う場合は該当案件のSVGを `svg` で指定する。

表セルは `{text, rowspan?, colspan?, class?}`（文字列も可）。`stats` の追加情報 `facts / booth / cost / costNote` は省略可。社長パースは `directVisual / crop / points / note`、`visualBrief` は禁止。

`crop` は元画像座標の `x, y, width, height, sourceWidth, sourceHeight`。ファイルの再描画・明度変更をせず、元画像を `<img>` で置き、表示窓だけを変える。元画像の資料全体や平面図をスクリーンショットとして拡大しない。

## 固定プロンプト

`gen-visuals.mjs` は以下の共通文に各ページの `visualBrief` を続け、`photoSources` を `--img` で渡す。

> 実写真の質感を保つ／人物は自然で顔の重複なし／文字・ロゴ・数字・表・図解・透かしを描かない／看板・衣服の文字とロゴを無地にする／アスペクト比16:9／明るい展示会場の光／施工完了後のブースと自然な接客／設営・搬入・床のゴミ・資材・私的集合写真・まばらな会場は不可。

フルブリードか縦長パネルかは `visualBrief` に記載。既存APIが16:9固定なので縦長パネルは中央45%に被写体を置くよう指示し、HTMLでクロップする。数値・文字・表・平面図は生成画像へ渡さない。人物や細かな背景文字は生成後の目視検査も必要。

## 素材の採用と失敗時

素材はDriveフォルダへ集約する（例: `1hRRRV2hAXH_cjoFOd_YF0KPFE-xwrIgb`）。完成ブース・賑わい・接客・商談・清潔な仕上がりを目視で選び、ファイル名だけで判定しない。まばらな会場・設営中・床のゴミや資材・私的集合写真は不可。大きな他社ロゴはモザイク、生成写真では無地にする。社長パースがあればAIパースを作らず元画像を直接表示する。

- 出力は `visuals/<page-id>.png`。画像APIがJPEGのバイトを返しても、生成済み画像をネイティブ解像度のままローカルでPNGに変換する。画像内容は変更しない。
- 429を含む失敗は60秒待機して再試行、1ページ最大3回の呼出し。3回失敗、または429以外の回復不能エラーなら実写真へフォールバック。既存gen-image内部のモデル切替はそのまま。
- `--force` の失敗でも既存正常画像を維持。生成途中は `.pending.png` を使い、デコード済みの正常画像だけ最終パスに置く。デコード不能の返却データは `.rejected-*.bin` に保存し、失敗内容を記録。
- 全実行の試行・失敗・モデル出力・プロンプト・形式変換・スキップは `gen-visuals-log.json` に追記。既存のログを消さない。

## 組版・検証

- 1ページ1メッセージ。1600×900、`@page`一致。navy / teal / 白 / amber。本文外側余白96px以上（写真のフルブリードは例外）、数字96px級、単位は小さく。
- 見出し14字超・導入本文の推定3行超は `out/build-checks.json` に警告。ビルドは止まらないので、警告を読んで直す。表セル・構造化項目・脚注は導入本文と区別する。
- 写真面積40%以上。暗化filter・opacityなし。表・平面図主体は写真を省略する。表紙は白い文字面・キャプションが隠す面積も差し引いて検査する。
- `preview.mjs` は画像decode・フォント読込を待ち、本文実測行数、写真面積、文字切れ、フッター衝突、暗化を検査する。問題があればPNG・`out/preview-checks.json` を残してexit 1。
- 全ページPNGをReadで原寸目視し、写真 / 余白 / 文字量 / 数字 / 一貫性の5観点を5点満点で採点。写真のない図表ページは写真のみ対象外。1項目でも3点以下なら直し、build→preview→全ページ目視をやり直す。
- `visual-review.json` は下の形式。再出力後は採点も更新する。保存後、次のコマンドで報告を更新できる。

```json
{"pages":[{"page":1,"photo":4,"space":4,"text":4,"numbers":4,"consistency":4,"note":"原寸で確認した所見"}],"summary":"全ページのレビュー所見"}
```

```sh
node --input-type=module -e "import('./deck-hybrid/report.mjs').then(m => m.writeReport())"
```

この採点例は承認済み結果ではない。`BUILD-REPORT.md` は現在の検査記録だけを集計する。目視・元原稿照合が未実施なら、そのまま未実施と記録する。

## PDF・Drive・修正分担

`build.mjs` は既存 `html-to-pdf.mjs` でPDF化し、PDFシグネチャとページ数を確認する。Drive・Git操作は含まない。完成PDFは既存のDriveアップロード経路で保存し、既存file IDがあればPATCHしてURLを維持する。kimへは `?authuser=kim@orgiast.jp` 付きURLを渡す。

写真の不満はGeminiで再合成。文字・数字の不満はClaudeが `pages.json` / CSSを修正。Gensparkは写真配置の面積比・余白の参考にレンダを見るだけ。Canvaを使わない理由は [../SKILL.md](../SKILL.md) を参照。
