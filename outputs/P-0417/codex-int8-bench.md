# Codex 指示: int8-bench.mjs 実装

## 目的
int8（8ビット整数）精度と fp16 の画像生成性能を比較するベンチマークツールを実装する。

## 出力ファイル
- `tools/int8-bench.mjs` — ベンチマーク本体
- `tools/int8-bench.test.mjs` — テスト

## 仕様

### CLI
```bash
node tools/int8-bench.mjs [--precision int8|fp16|auto] [--model <id>] [--prompt "<text>"] [--video] [--count <n>] [--json] [--out <path>]
```

### 引数
- `--precision`: 精度指定（既定: `auto` = Genspark 既定）
- `--model`: モデルID（既定: `nano-banana-2-flash-lite`）
- `--prompt`: プロンプト文字列（既定: 内蔵の標準プロンプトを使用）
- `--video`: 動画生成モード（対応モデルのみ）
- `--count`: 各条件の実行回数（既定: 3）
- `--json`: JSON出力
- `--out`: 出力先���ス（既定: `outputs/P-0417/benchmark-results-{date}.csv`）

### 測定項目
1. 生成時間（秒）— リクエスト開始から最初の結果まで（TTFT）と完了まで（total）
2. VRAM使用量（MB）— 生成前後の差分（nvidia-smi が利用可能な場合のみ）
3. エラー有無

### 実装の注意
- `tools/image-gen.mjs` を import して再利用する（車輪の再発明をしない）
- Genspark CLI（`gsk`）が利用できない環境でも `--json` でシミュレーションデータを出力できるようにする（`GSK_API_KEY` 未設定時は mock）
- テストは `node --test tools/int8-bench.test.mjs` で単独実行可能にする
- Windows 対応（`gsk.cmd`、パス区切り）
- 結果は追記モードで CSV に保存し、後続の分析ツールで読み取れる形式にする

### テスト要件
1. 引数パースのテスト（全オプションの組み合わせ）
2. 空プロンプトのエラーハンドリング
3. 不明な精度指定のエラー
4. CSV 出力形式の検証
5. VRAM 取得の fallback（nvidia-smi 不在時もエラーにしない）

## 完了条件
- `node tools/int8-bench.test.mjs` が全テスト緑
- `node tools/int8-bench.mjs --count 1 --json` がエラーなく完了し、JSON を stdout に出力する
- `node tools/int8-bench.mjs --count 1 --out outputs/P-0417/test.csv` で CSV ファイルが生成される