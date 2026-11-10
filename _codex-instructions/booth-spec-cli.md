# 実装指示: ブース仕様データCLI管理ツール

## 概要
オージャストのブース案件データをJSONファイルで管理し、CLIから操作するツールを作成する。

## やること

### 1. `data/booth-specs/` ディレクトリとデータファイル
`data/booth-projects.json` の3件を、1ファイル1案件のJSONとして `data/booth-specs/` に分割する。

各JSONファイルの構造:
```json
{
  "projectId": "C0056",
  "title": "産業DXを体感できる商談重視ブース",
  "client": "三共精機株式会社",
  "industry": "産業機械・技術商社",
  "event": {
    "name": "ものづくりワールド東京 2026",
    "type": "展示会"
  },
  "booth": {
    "size": "3m×6m 小間"
  },
  "period": "2026年6月",
  "services": ["企画設計", "空間デザイン", "グラフィック制作", "施工", "会期中運営支援"],
  "description": "限られた3m×6mの区画で、製品展示と落ち着いた商談を両立したブースです。正面開放の動線、幅900mm以上の通路、高さ2,500mmの造作内に受付・展示棚・4席の商談スペース・ストックを整理しました。",
  "highlights": [
    "正面から展示内容を把握できる一面開放レイアウト",
    "来場者動線を妨げない受付カウンター配置",
    "展示棚と4席の商談エリアを明確にゾーニング"
  ],
  "results": {
    "metric": "有効商談数",
    "change": "+35%",
    "detail": "会期中の有効商談数が前回比で約35％増加し、営業担当者からも案内しやすい動線として高い評価を得ました。"
  },
  "images": [
    {"path": "images/C0056/main.jpg", "alt": "ブース全体"},
    {"path": "images/C0056/meeting-area.jpg", "alt": "商談エリア"}
  ]
}
```

- `data/booth-specs/C0056.json` を作成（上記の内容）
- `data/booth-specs/C0062.json` を作成（東都マテリアル）
- `data/booth-specs/C0068.json` を作成（関西ロボティクス）

元の `data/booth-projects.json` はそのまま残す（参照用）。

### 2. `tools/booth-spec.mjs` — CLIツール

Node.jsスクリプト。シェバング `#!/usr/bin/env node`。外部依存なし（標準モジュールのみ）。

**引数パース**: 独自パース（`--flag value` 形式、コマンドは第1引数）

**コマンド**:

| コマンド | 動作 |
|---------|------|
| `list` | `data/booth-specs/*.json` から全件読み込み、ID・タイトル・イベント・クライアントを表形式で表示 |
| `list --industry <値>` | 指定業種のみに絞り込み |
| `get <projectId>` | 1件をYAML-like形式で表示（JSONをインデント付きで人が読みやすい形に） |
| `get <projectId> --format json` | 1件をJSONで表示 |
| `validate` | 全ファイルを読み、必須フィールドの存在チェック。エラー件数と内容を表示。終了コード1で終了 |
| `add --file <path>` | 指定ファイルを読み込み、projectIdで重複チェックして保存。既存は上書き（メッセージ表示） |
| `export json` | 全件をJSON配列として標準出力 |
| `export json --pretty` | 整形JSON出力 |

**バリデーションルール**:
- 必須: projectId, title, client, industry, event.name, booth.size, period, services, description
- services は空配列でないこと
- projectId が `data/booth-specs/` 内で一意であること
- ファイル名が `{projectId}.json` と一致すること

**YAML-like表示**: 以下の書式で出力:
```
projectId: C0056
title: 産業DXを体感できる商談重視ブース
client: 三共精機株式会社
event:
  name: ものづくりワールド東京 2026
highlights:
  - 正面から展示内容を把握できる一面開放レイアウト
  - 来場者動線を妨げない受付カウンター配置
```
JSONを再帰的にYAML-likeテキストに変換する関数を内蔵する。

### 3. `tools/booth-spec.test.mjs` — テスト

Node.js標準テストランナー（`node --test`）対応。

テスト内容:
1. **list**: ファイル一覧を読み込み正しい件数を返す
2. **list --industry**: フィルタリングが機能する
3. **get**: 既存IDで正しいデータが取得できる
4. **get 存在しないID**: エラー終了コード1
5. **validate**: 既存データがバリデーション通過する
6. **validate (不正ファイル)**: テスト用に不正JSONを用意してバリデーションエラーを確認
7. **add**: 新規ファイルを追加できる
8. **add 重複**: 上書き警告が出る
9. **export json**: JSON配列出力
10. **export json --pretty**: 整形JSON出力

テストは一時ディレクトリを使うか、`BOOTH_SPECS_DIR` 環境変数でテスト用ディレクトリを指定できるようにする。

実装上のヒント:
- ブースデータディレクトリの指定は 環境変数 `BOOTH_SPECS_DIR`（優先）→ デフォルト `data/booth-specs/`（スクリプト位置からの相対）
- 全関数は `async` または同期で実装、テストから import して呼べるよう export
- `main()` 関数を export し、`import` でテスト、`node tools/booth-spec.mjs list` でCLIとしても動く