# booth-3d: 保有機材の 3D 部材ライブラリ（第 1 段階）

Drive 上の保有機材 STL 23 件を、Blender をヘッドレスで動かして「部材 1 点 = 1 アセット」に分割・命名し、
`library.blend`・`library.json`・サムネイル PNG を作る。展示会ブースの 3D パース・図面を自動生成するパイプラインの土台。

## 使い方

```
node tools/booth-3d/build-library.mjs --out <出力フォルダの絶対パス>
```

1. `ensure-blender.mjs` が Blender の場所を確認する（無ければ公式配布から取得）
2. STL が `~/.claude/booth-3d/stl/` に無ければ `fetch-stl.mjs` が Drive から取得する
3. `build-library.py`（Blender 内）が連結成分に分割し、人型を除き、同寸法をまとめ、`asset_id` を付ける
4. `render-thumbs.py`（Blender 内）が各アセットを 600×450 の PNG に描画する
5. アセット数 = PNG 数、`asset_id` が `asset-naming.mjs` の規則どおりかを検査する

単体でも使える: `node tools/booth-3d/ensure-blender.mjs`（パスを 1 行出力）、`node tools/booth-3d/fetch-stl.mjs [--out <dir>]`。
テスト: `node --test tools/booth-3d/`（Blender が無い環境では Blender 依存の 1 件が「測定不能（exit 2 相当）」の TODO 表示になる）。

## 出力

- `library.json`: `{asset_id, source_file, dims_mm:[W,D,H], count_in_stl, faces, inventory, thumb}` の配列。`inventory` は後続段階で在庫数を入れる（現在 null）
- `library.blend`: コレクション `assets/<asset_id>` ごとに 1 オブジェクト。原点は底面中心、単位は 1 = 1mm
- `thumbs/<asset_id>.png`

## 環境変数（移管時に差し替える値）

| 変数 | 既定 | 用途 |
|---|---|---|
| `BOOTH3D_SA_KEY` | `~/.claude/keys/aujust-sheets-reader.json` | Drive 取得に使うサービスアカウント鍵（JSON） |
| `BOOTH3D_DWD_SUB` | `seisaku-team@orgiast.jp` | ドメイン全体委任で成り代わるユーザー。STL はこのアカウントの権限でだけ見える（所有は外部 tunagi5671@gmail.com） |
| `BOOTH3D_BLENDER` | `~/tools/blender/blender.exe` | 既存の Blender のパス |

管理を別アカウントへ移すときは、新アカウントに STL フォルダを共有し、SA 鍵のパスと sub を差し替える。
STL の Drive ID は `stl-sources.json`（id・name・slidePage）。`slidePage` は「【マスター】保有機材リスト」のページ番号で、未確認の間は null。

## 分割の考え方（STL の実態）

1 ファイルに「在庫全部＋人型スケールフィギュア」が並んで入っている。そのため:

- **cluster（既定）**: 連結成分のバウンディングボックスが 2mm 以内で重なるものを 1 部材へ束ねる（トラスは弦材・斜材・端板が別成分なので、束ねて 1 本にする）
- **grid（ステージ）**: 床板が 2 枚の大きな塊に一体化しているため、1m グリッドで面を切って 1m 角パネルにし、床下の脚・斜材を足元のセルへ寄せる
- **人型除外**: 高さ 1880〜1940mm かつ X・Y 幅がともに 800mm 未満の部材（STL に名前はないので寸法で判定）
- **同一寸法の集約**: 各辺 ±5mm（XY は入れ替え可）を 1 アセットにして `count_in_stl` を数える

## 制約

- STL・Blender 本体は Git に入れない（Drive／公式配布のキャッシュ）。Python は Blender 同梱のみ、Node は標準 API のみ
- `render.filepath` は必ず絶対パス（相対だと Blender がドライブ直下へ書く）
- 自動取得の Blender は Windows x64 のみ。他 OS は `BOOTH3D_BLENDER` で指定
