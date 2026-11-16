# Booth Spec Generator with Prompt Cache (X-0044)

## 目的
AIニュース提案 [X-0044] の実証実験。ブース仕様生成におけるプロンプトキャッシュ最適化でエージェント再読みコストを削減する。

### 目標数値（AI News 投稿より）
- キャッシュ読み53%・73%（prefix・tool output 別）
- コスト0.77（従来比）
- 精度0.97
- ツール出力27%再利用

## アーキテクチャ

```
┌─────────────────────────────────────────────────┐
│                cache-prefix.md                   │
│  (固定プレフィックス: 過去案件・標準サイズ・     │
│   設計原則・スキーマ定義) ← キャッシュ対象      │
└────────────────────┬────────────────────────────┘
                     │ プロンプト先頭に常に挿入
                     ▼
┌─────────────────────────────────────────────────┐
│           generate-spec.mjs                      │
│  可変入力 (クライアント・予算・会場制約) と      │
│  キャッシュプリフィックスを結合 → LLM呼び出し    │
└──────────┬──────────────────────┬───────────────┘
           │                      │
           ▼                      ▼
┌──────────────────┐   ┌──────────────────────────┐
│ spec-cache.mjs    │   │   生成された spec JSON    │
│ 圧縮・GC・再利用  │   │   (booth-spec.schema.json)│
└──────────────────┘   └──────────────────────────┘
```

## キャッシュ戦略

### 1. 固定プレフィックス（cache-prefix.md）
- **過去案件データ**: `data/booth-projects.json` の全案件（プロジェクトID・クライアント・規模・期間・特徴）
- **標準ブースサイズ**: 3m×3m / 3m×6m / 6m×6m / 6m×9m の寸法・高さ制限・開放面の典型構成
- **設計原則**: X-0009 の5原則（「見せる」より「話せる」空間・再利用部材・商談ゾーン・半開放・ハイブリッド展示）
- **スキーマ定義**: `booth-spec.schema.json` の構造
- **資産一覧**: 保有機材（LEDUP・システムパネル・什器類）の寸法と用途
- この prefix はセッション間で変わらない → プロンプトキャッシュに乗る

### 2. ツール出力圧縮（spec-cache.mjs）
生成された spec JSON を保存時に圧縮:
- `pos_mm` 配列を相対座標に変換（基準点からの差分）
- 同一 asset_id の重複定義を除去
- 小数点以下2桁に丸め
- 空フィールド・null を削除

### 3. GC（spec-cache.mjs）
- 同一 case_id の古い提案は最大5世代まで保持
- 30日経過した提案は自動削除
- 週1回の GC で圧縮率レポートを出力

### 4. バッチ生成（generate-spec.mjs --batch）
複数案を1回のLLM呼び出しで生成:
- 予算3段階（200万・300万・500万）の比較案
- サイズ違い（3x3 vs 3x6 vs 6x6）
- 再利用ブース vs 新規制作の比較

## ファイル構成

```
apps/booth-spec-generator/
├── SPEC.md               # 本設計書
├── cache-prefix.md        # プロンプトキャッシュ用固定プレフィックス
├── generate-spec.mjs      # ブース仕様生成ツール
├── spec-cache.mjs         # キャッシュ管理（圧縮・GC）
├── spec-cache.test.mjs    # テスト
└── README.md              # 使い方
```

## generate-spec.mjs 仕様

### 引数
```
node apps/booth-spec-generator/generate-spec.mjs \
  --client "クライアント名" \
  --event "展示会名" \
  --budget 300 \
  --size "3x6" \
  --requirements "商談重視・実機デモあり" \
  [--batch] \
  [--output ./outputs/spec-{case_id}.json]
```

### 出力
- `booth-spec.schema.json` 準拠の JSON
- 概要テキスト（マークダウン）
- BOM 候補（部材リスト）

### --batch モード
`--budget "200,300,500"` で3案同時生成。
全案を1回のLLM呼び出しで生成し、比較表も出力。

## spec-cache.mjs 仕様

### 機能
- `compress(spec)`: spec JSON を圧縮（相対座標化・重複除去・桁丸め）
- `decompress(compressed)`: 元の spec に復元
- `gc(cacheDir, maxAgeDays=30, maxGenerations=5)`: 古い提案を削除
- `list(cacheDir)`: キャッシュ内の提案一覧

### 圧縮率目標
- ツール出力27%削減（AI News 投稿値）
- 復元精度100%（可逆圧縮）

## 検証方法
1. `node apps/booth-spec-generator/spec-cache.test.mjs` — 圧縮・復元・GC の単体テスト
2. 実際のブース案件（C0056・C0062・C0068）を入力として生成テスト
3. 生成結果を `booth-spec.schema.json` でスキーマ検証
4. キャッシュヒット率の計測（ログ出力）