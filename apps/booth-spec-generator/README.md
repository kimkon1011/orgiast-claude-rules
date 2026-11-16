# ブース仕様生成 with Prompt Cache（X-0044）

展示会用ブースの仕様JSONをテンプレートベースで生成し、プロンプトキャッシュを最適化するツール群です。

## 概要

- **spec-cache.mjs** — ブース仕様JSONの圧縮・復元・GC・保存・読み込みを行うキャッシュ管理モジュール
- **generate-spec.mjs** — ブース仕様生成CLIツール（LLM非依存・テンプレートベース）
- **spec-cache.test.mjs** — 上記モジュールのテスト

## セットアップ

依存関係はありません。Node.js 22+ が必要です。

```bash
cd apps/booth-spec-generator
```

## 使い方

### ブース仕様の生成

```bash
node apps/booth-spec-generator/generate-spec.mjs \
  --client "三共精機" \
  --event "ものづくりワールド東京 2026" \
  --budget 300 \
  --size "3x6" \
  --requirements "商談重視・実機デモあり"
```

### dry-run モード（生成内容の確認のみ）

```bash
node apps/booth-spec-generator/generate-spec.mjs \
  --client "三共精機" \
  --event "ものづくりワールド東京 2026" \
  --budget 300 \
  --size "3x6" \
  --dry-run
```

### バッチ生成（複数予算案を同時生成）

```bash
node apps/booth-spec-generator/generate-spec.mjs \
  --client "三共精機" \
  --event "ものづくりワールド東京 2026" \
  --budget "200,300,500" \
  --size "3x6" \
  --batch
```

### 出力ファイル指定

```bash
node apps/booth-spec-generator/generate-spec.mjs \
  --client "三共精機" \
  --budget 300 \
  --size "3x6" \
  --output "./outputs/spec-{case_id}.json"
```

### テスト実行

```bash
node apps/booth-spec-generator/spec-cache.test.mjs
```

## サポートするブースサイズ

| サイズ | 寸法 | 高さ制限 | 適した予算帯 |
|--------|------|---------|-------------|
| 3x3 | 3000×3000mm | 2700mm | 100-200万円 |
| 3x6 | 6000×3000mm | 3000mm | 150-350万円 |
| 6x6 | 6000×6000mm | 3500mm | 300-600万円 |
| 6x9 | 9000×6000mm | 4000mm | 500-1000万円 |

## アーキテクチャ

```
cache-prefix.md（固定プレフィックス）
       │
       ▼
generate-spec.mjs（テンプレートベース生成）
       │
       ├── spec-cache.mjs（圧縮・保存）
       └── spec-cache.mjs（読み込み・一覧）
```

## キャッシュ管理

生成された仕様は `~/.claude/booth-spec-cache/` に自動保存されます。
保存先を変更する場合は、環境変数 `BOOTH_SPEC_CACHE_DIR` にディレクトリを指定してください。

- **圧縮**: 浮動小数点の丸め（2桁）、null/空フィールド除去、重複item除去、相対座標化
- **GC**: 最大5世代保持、30日経過で自動削除（設定変更可能）
- **一覧**: キャッシュ内の全specのcase_id・タイトル・作成日・サイズを確認

## ファイル構成

```
apps/booth-spec-generator/
├── SPEC.md                 # 設計書
├── cache-prefix.md         # プロンプトキャッシュ用固定プレフィックス
├── generate-spec.mjs       # ブース仕様生成ツール
├── spec-cache.mjs          # キャッシュ管理（圧縮・GC）
├── spec-cache.test.mjs     # テスト
└── README.md               # 本ファイル
```

## ライセンス

OrgIast
