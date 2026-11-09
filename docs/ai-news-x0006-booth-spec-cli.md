# X-0006: ブース仕様データYAML CLI管理

> **提案**: AI開発はまずUIなしのハーネスから — ローカルでUIなしのデータ更新だけのハーネス（CLI、yaml）を作りしばらく運用。最初はビューワーとして使い、正本をシンプルに保つ。UIは最後。

## 目的

株式会社オージャストのブース提案・イベント管理において、ブース仕様データをYAMLで構造化し、CLIで管理するシンプルなハーネスを構築する。これにより:

- データの正本を人間とAIの両方が読み書きしやすい形式にする
- 後段のUI・API・レンダリングから独立したコアデータ層を確立する
- 案件の増加に伴うデータ管理のスケーラビリティを確保する

## ディレクトリ構造

```
booth-specs/
  C0056.yaml      # 案件ごとのYAMLファイル
  C0062.yaml
  C0068.yaml
schemas/
  booth-spec.schema.json  # JSON Schema によるバリデーション定義
tools/
  booth-spec.mjs          # CLIツール本体
  booth-spec.test.mjs     # テスト
```

## YAMLスキーマ

各ブース仕様YAMLは以下の構造:

```yaml
# メタ情報
projectId: string        # 案件ID (例: C0056)
title: string            # ブース名
client: string           # 顧客企業名
industry: string         # 業種

# イベント情報
event:
  name: string           # イベント名
  type: string           # イベント種別 (展示会/物産展/商談会 等)
  url: string (optional) # イベントURL

# ブース仕様
booth:
  size: string           # サイズ (例: 3m×6m 小間)
  layout: string (optional)  # レイアウト種別
  ceilingHeight: string (optional) # 天井高
  features: string[] (optional)   # 設備・特徴

period: string           # 開催時期 (YYYY-MM または自由形式)

services: string[]       # 提供サービス一覧

description: string      # 説明文
highlights: string[]     # 3つ程度のアピールポイント

# 成果 (optional)
results:
  metric: string         # 主要指標名
  change: string         # 変化 (例: +35%)
  detail: string         # 詳細説明

# 画像 (optional)
images:
  - path: string         # 画像パス
    alt: string          # 代替テキスト

# リンク (optional)
links:
  projectUrl: string (optional)    # プロジェクトページURL
  caseStudyUrl: string (optional)  # 事例詳細URL
```

## CLI インターフェース

```
node tools/booth-spec.mjs <command> [options]
```

### コマンド一覧

| コマンド | 説明 | 使用例 |
|---------|------|--------|
| `list` | 全ブース一覧（ID・タイトル・イベント） | `booth-spec.mjs list` |
| `list --industry <業種>` | 業種でフィルタ | `booth-spec.mjs list --industry ロボット` |
| `get <projectId>` | 1件をYAML表示 | `booth-spec.mjs get C0056` |
| `get <projectId> --format json` | 1件をJSON表示 | `booth-spec.mjs get C0056 --format json` |
| `add --file <yaml>` | YAMLファイルから追加/更新 | `booth-spec.mjs add --file new-booth.yaml` |
| `validate` | 全YAMLファイルをバリデーション | `booth-spec.mjs validate` |
| `export json` | 全件をJSON配列で標準出力 | `booth-spec.mjs export json` |
| `export json --pretty` | 整形JSON出力 | `booth-spec.mjs export json --pretty` |

### 終了コード

| コード | 意味 |
|--------|------|
| 0 | 成功 |
| 1 | バリデーションエラー / ファイル未存在 |
| 2 | 引数エラー |

## データソース

既存の `data/booth-projects.json` の3件をYAMLに移行する。移行後もJSONは参照用に残すが、正本はYAMLとする。

## 非機能要件

1. **外部依存ゼロ**: 使用するモジュールは Node.js 標準ライブラリのみ（fs, path 等）。yaml パースは標準では未対応のため、JSONで代用するか、軽量手書きパーサーを使用する
   - → YAMLの代わりにJSONスキーマ＋JSONファイルでも良いが、X-0006の趣旨は「yamlでCLI管理」。Node.js標準でyamlを読めないため、`js-yaml` 相当の依存を避けるなら `export json` は `import` でJSONを返す方式にする
   - ★ 結論: YAML拡張子だが中身は厳密なJSONスーパーセットとして扱う。Node.js標準のJSONパーサーで読み、コメントのみ除去する簡易パーサーを内蔵する。または `JSON5` 的な緩いパースを実装する
   - 実際の運用: YAMLを書き慣れた人なら手で編集し、CLI内部ではJSONとして扱うハイブリッド方式

2. **自己完結**: 1ファイルで動作すること。スクリプト内に全ロジックを持つ

3. **エラーハンドリング**: ファイルがない、フォーマットがおかしい場合に意味のあるエラーメッセージを表示

## 実装計画

### Step 1: スキーマ定義と既存データ移行
- `schemas/booth-spec.schema.json` (JSON Schema)
- `booth-specs/C0056.yaml`, `C0062.yaml`, `C0068.yaml` 作成

### Step 2: CLIツール実装
- `tools/booth-spec.mjs` — 全コマンドに対応

### Step 3: テスト
- `tools/booth-spec.test.mjs` — 全コマンドのテスト

### Step 4: PR作成・マージ
- PR作成、CI通過確認、automerge