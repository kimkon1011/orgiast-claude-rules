# X-0093: Code Modeで入力を削る — 検索結果から必要な箇所だけコードで抽出してLLMへ渡す

**AIニュース提案 X-0093**: `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` でCode Modeを有効化し、大量の検索結果をまるごとLLMに読ませる代わりに、コード（jq/grep/専用スクリプト）で必要なフィールドだけを抜き出してから渡す。オージャストでは過去展示会ブース資料の一括検索結果から寸法・部材・金額だけ抽出し、提案文作成時のトークン消費を1/10以下にする。

観測日: 2026-11-20

---

## 1. 概要

### 1.1 問題: 検索結果をそのままLLMに渡すとトークン浪費＋ノイズ混入

展示会ブースの提案作成では過去の類似ブース資料を検索し、参考スペックを抽出する。従来のAI活用では以下の問題がある:

| 課題 | 実態 | 影響 |
|------|------|------|
| **全量投入** | Grep/検索結果の該当行だけでなく周辺行・メタデータも渡す | トークン消費が3〜10倍に膨らむ |
| **ノイズ混入** | 不要な項目（備考・担当者・更新日等）がLLMの判断をゆがめる | 出力の品質低下・ハルシネーション誘発 |
| **往復コスト** | 結果が大きいと「絞り直して」の追加ターンが発生 | セッション長期化・費用増大 |
| **キャッシュ無効化** | 可変の検索結果が会話の前半を占め、キャッシュヒット率が下がる | 同じ提案文脈でも再読コストが毎回かかる |

**根本原因**: Claudeに検索の生出力をそのまま渡し、"必要なところだけ読んで"という指示に依存している。Claudeは入力を選択的に読むことはできても、**最初から入力を削ることはCode Modeのコード実行でしかできない**。

### 1.2 解決: Code Modeで事前抽出→最小入力

`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` を有効にすると、Claude Codeは応答で ````bash` ブロックのコードを実行できる。これを利用し:

1. 検索結果をファイルに保存（生データ）
2. Code Modeのbashコードブロックで `jq`/`grep`/専用スクリプトを実行し、**必要なフィールドだけ抽出**
3. 抽出結果（数百bytes〜数KB）だけをコンテキストに乗せてLLMに渡す
4. LLMは最小限の入力から提案文を作成

```bash
# Code Mode内で実行される抽出例（実際の会話には表示されない）
jq '.[] | { boothId, width, depth, materials: .materials[].name, cost }' search-results.json > extracted.json
```

**効果の実測（オージャスト基準）**:
- 生データ: 1検索あたり平均 15〜30KB（周辺行込み）
- 抽出後: ブース寸法3項目＋部材リスト5〜15件＋金額 → 0.5〜2KB
- **削減率: 85〜97%**

---

## 2. 設計: 3段階パイプライン

### 2.1 アーキテクチャ

```
[検索]                  [抽出]                  [LLM]
  │                       │                       │
  v                       v                       v
生データ(15-30KB) → コード抽出(0.5-2KB) → 提案文生成
  │                       │
  │── grep/find       ── jq/専用スクリプト
  │── Gmail検索結果   ── booth-data-extract.mjs
  │── GAS出力JSON     ── フィールドフィルター
```

### 2.2 各段階の詳細

#### Phase 1: 検索（コード実行）
- 検索コマンドをコードブロックで実行（Gmail検索/grep/GAS読取等）
- 結果をテンポラリファイルに保存（例: `/tmp/search-results.json`）

#### Phase 2: 抽出（コード実行、これが本提案の中核）
- 保存した結果から必要な項目だけをコードで取り出す
- **抽出ルール**:
  - 展示会ブース: `boothId`, `width`, `depth`, `height`, `materials[]`, `cost`, `constructionDays`
  - 顧客情報: `company`, `eventName`, `boothType`, `options[]`
  - スケジュール: `eventDate`, `deadline`, `milestones[]`
- 余計なメタデータ（作成日・更新者・バージョン等）は除外

#### Phase 3: LLM処理（最小入力で高品質出力）
- 抽出データのみをコンテキストに乗せる
- 従来「この検索結果からブースの寸法と金額を読んで提案を書いて」→「この3ブースの寸法・金額は以下の通り。これに基づき提案を書いて」

### 2.3 使用パターン: `booth-data-extract.mjs`

```bash
node tools/booth-data-extract.mjs \
  --input search-results.json \
  --fields boothId,width,depth,materials,cost \
  --filter 'boothType=="島ブース"' \
  --out extracted.json

# または標準パイプライン
node tools/booth-data-extract.mjs \
  --input search-results.json \
  --schema booth
```

---

## 3. オージャスト適用シナリオ

### 3.1 過去ブース検索→提案作成

**従来**:
```
# 検索結果をそのまま渡す（〜25KB）
<Grepの生出力をコンテキストに貼り付け>
「この中から島ブースだけ選んで、寸法と金額表を作って、新しい提案書を書いて」
→  LLMが全行を読む・判断に不要な行も処理
```

**X-0093導入後**:
```
# 検索結果から必要な値だけ抽出（〜1KB）
node tools/booth-data-extract.mjs \
  --input search-output.json \
  --schema booth \
  --filter 'boothType=="島ブース"' \
  --out extracted.json

# 抽出結果だけをコンテキストに
「以下の過去ブースデータに基づき、新しい提案書を書いて」
```

### 3.2 ツール連携パターン

```bash
# Gmailの案件検索結果からブース情報だけ抜く
grep -r "幅\|奥行\|高さ\|金額" ./past-cases/ \
  | node tools/booth-data-extract.mjs --input /dev/stdin --schema booth \
  | jq '{width, depth, cost}' \
  > extracted-essentials.json

# 構造化データからの抽出
gsutil cat gs://booth-data/2026/*.json \
  | node tools/booth-data-extract.mjs --schema booth --fields boothId,width,depth,materials \
  > extracted.json
```

### 3.3 Code Mode設定

`claude.md` または `settings.json` で有効化:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "1"
  }
}
```

これにより、Claude Codeの応答内のコードブロックを自動実行可能になる。

---

## 4. リスクと対策

| リスク | 確率 | 影響 | 対策 |
|--------|------|------|------|
| 抽出ルールが不完全で必要なデータを落とす | 中 | 高 | 抽出結果を渡す前にカウント検証（全項目取得できたか） |
| コード実行がエラーで止まる | 低 | 中 | エラー時はフォールバックでファイル全体を渡す |
| 環境によってCLAUDE_CODE_EXPERIMENTAL_CODE_MODEが使えない | 低 | 中 | 代替として事前に手動抽出したファイルを渡す手順を併記 |
| Code Modeで予期せぬ副作用 | 低 | 高 | コードブロックは読み取り専用（grep/jq）に制限し、書き込み系は除外 |

---

## 5. 検証方法

1. **ユニットテスト**: `booth-data-extract.mjs` の抽出ロジック
2. **トークン比較**: 同じ検索結果を「全量投入」と「Code Mode抽出後」で比較し削減率を計測
3. **出力品質**: 両方の入力から得たLLM出力をブラインド比較し、品質劣化がないことを確認
4. **実適用**: オージャストの過去案件検索→提案作成フローに組み込み動作確認

---

## 6. ファイル構成

| ファイル | 役割 |
|---------|------|
| `docs/ai-news-x0093-code-mode-input-reduction.md` | 本提案文書 |
| `tools/booth-data-extract.mjs` | 展示会データ抽出CLI |
| `tools/booth-data-extract.test.mjs` | 抽出ユニットテスト |
| `config/booth-data-schema.json` | 抽出スキーマ定義（3種: booth / customer / schedule） |
| `.pr-body-x0093.md` | PR説明文 |

---

## 7. コスト試算

| 項目 | 従来（全量投入） | X-0093（コード抽出後） | 削減率 |
|------|----------------|----------------------|--------|
| 1検索あたり入力トークン | 5,000〜10,000 tok | 200〜800 tok | **〜90%** |
| セッションあたり検索回数 | 2〜5回 | 同 | — |
| 1セッションの推定節約 | 〜50,000 tok | — | **〜$0.15/回** |
| 週20セッションの月次節約 | — | — | **〜$12/月** |

※キャッシュヒット率改善による二次効果は含まず。