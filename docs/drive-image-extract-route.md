# Drive 上の資料から画像を抽出する経路（実測・2026-09-20）

handoff-audit `980e314f9cd23cfb`（「Drive 上の資料から画像抽出を代替経路で行う」）の調査・検証記録。
**user の手作業ゼロ**で完結する経路が実在することを、実ファイルの取り出しまで確認した。

## 結論

`read_file_content`（Drive MCP）に依存せず、**DWD サービスアカウント（kim@orgiast.jp を impersonate / `drive` スコープ）で Drive API v3 を直接叩けば画像を実取り出しできる**。
既存の認証ヘルパ `tools/lib/drive-auth.mjs` だけで足り、権限追加・OAuth 同意・API 有効化は一切不要。

## 検証済みの経路（すべて実測で有効なバイト列を確認）

| 資料の種類 | 経路 | 実測結果 |
|---|---|---|
| 画像ファイル（jpg/png） | `GET /files/{id}?alt=media` | `Screenshot_20260906-152115.jpg` 69615B / magic `ffd8ffe0…`（=JPEG）・Drive の size 表記と一致 |
| Google ドキュメント（本文埋め込み画像） | `GET /files/{id}/export?mimeType=application/zip` → zip 内 `images/*` | Doc「支柱を作ってほしい」(id `1ohELJfXUcNLiRsJHbNMXxhVOyEe8XJADybPwNAYCmvc`) の `images/image1.jpg` を **60439B で取り出し**、magic `ffd8ffe0…` |
| Google スライド | pptx export → zip 内 `ppt/media/*` | `会場リスト提案 のコピー` の `ppt/media/image1.jpg` を **5957B で取り出し**、magic `ffd8ffe0…` |
| PDF | `GET /files/{id}?alt=media` | 71694B / magic `%PDF-`（9616738B の大物も同様） |

51 件の Google ドキュメントを走査したうち、画像を含む Doc は 1 件見つかり、そこから実際に画像が取れた。

## 落とし穴（実測で踏んだもの）

1. **Google の export zip はストリーミング形式**で、ローカルファイルヘッダの圧縮サイズが 0。
   ローカルヘッダ（`PK\x03\x04`）を走査する実装では**ファイル名は取れても中身が取れない**。
   EOCD（`PK\x05\x06`）→ 中央ディレクトリ（`PK\x01\x02`）を辿って実サイズとローカルヘッダ位置を得る必要がある。
2. **Google Docs API は本 SA プロジェクトで無効**（`403 Google Docs API has not been used in project …`）。
   したがって `inlineObjects[].imageProperties.contentUri` 経由の取り出しは**使えない**（有効化は権限変更にあたるため本次では行っていない）。Drive API の export 経路は Docs API 不要。
3. **Slides の `image/png` export は 400 `The requested conversion is not supported.`**
   UI の「スライドを画像でダウンロード」相当は API には無い。pptx export → `ppt/media/*` を使う。
4. 画像を持たない Doc の zip は `entries=1`（HTML のみ）。docx export も `entries=9` で `word/media/` は付かない。

## 未確認（断定しない）

- **Drive MCP `read_file_content` の挙動そのもの**は本セッションでは未確認。
  このヘッドレス環境には Google Drive MCP のツールがロードされておらず（subagent のツール一覧にも無し）、呼び出し自体ができなかった。
  「MCP が使えない」ではなく「**本環境では未ロード＝未確認**」である。
- ただし上記のとおり、画像抽出という目的には MCP は**不要**であることが実測で示せた。

## 再現手順

実測に使ったスクリプト（読み取り専用・Drive への書き込みなし）:
`~/.claude/auto-session/runs/2026-09-20-11-drive-image-probe.mjs`
実行ログ: 同ディレクトリ `2026-09-20-11-probe4.log`、取り出した実ファイル: `2026-09-20-11-probe-out/`

```
node ~/.claude/auto-session/runs/2026-09-20-11-drive-image-probe.mjs
```

## 残ったこと

- この経路を再利用可能なツール（`tools/drive-image-extract.mjs` + テスト）に切り出すのは次回。
  実測済みのロジック（中央ディレクトリ走査）は上記スクリプトに入っているが、**リポジトリのツールとしては未実装**。
