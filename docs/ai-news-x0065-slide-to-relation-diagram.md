# X-0065: 箇条書きPPTを関係図へ組み直す

**AIニュース提案 X-0065**: PowerPoint の箇条書きスライドからテキスト構造を解析し、関係パターン（プロセス・比較・階層・循環・タイムライン）を検出、Mermaid 図に変換して元のスライドに重ね書きする。

観測日: 2026-11-27（出典: DeckBolt "Every Bullet List Is Hiding a Diagram" 他）
確定日: 2026-11-29（本ドキュメント作成）

---

## 1. 概要

箇条書きスライドは、多くの場合「プロセス」「比較」「階層」「循環」「時系列」のいずれかの関係性を持っている。DeckBolt の 5 パターン分析（信号語ベース）を機械的に適用し、Mermaid DSL で関係図を生成、元の PPTX スライドの箇条書きを図に置き換える。

### 全体フロー

```
[PPTX入力] → [箇条書き抽出] → [パターン検出] → [Mermaid生成] → [図挿入] → [PPTX出力]
     1               2                3               4             5             6
```

---

## 2. パターン検出ルール（DeckBolt 5 Patterns）

| 関係 | 信号語（日本語＋英語） | 変換先 Mermaid 図 |
|------|----------------------|-------------------|
| **Steps**（プロセス） | まず・次に・その後・最後に / first, then, next, finally | `flowchart LR` × 矢印 |
| **Options**（比較） | 一方・対して・vs・または・代わりに / vs, instead of, but, compared to | `flowchart LR` × 2列比較 |
| **Levels**（階層） | 含む・構成・分類・上位・下位 / includes, made up of, under, because | `flowchart TD` × ツリー |
| **Loops**（循環） | 繰り返す・再び・フィードバック・サイクル / repeat, again, feeds back, cycle | `flowchart LR` × 循環矢印 |
| **Dates**（タイムライン） | Q1・Q2・2025年・フェーズ1・〜月 / dates, quarters, phases, year | `timeline` × 時系列 |

### 信号語スコアリング

- 各パターンに信号語が出現するたび +1 点
- 最スコアのパターンを採用（同点は優先順位: タイムライン > 階層 > プロセス > 循環 > 比較）
- 1文に複数パターンの信号語があっても独立に加点

---

## 3. ツール仕様

### コマンド

```bash
node tools/ppt-to-relation.mjs \
  --input "提案書.pptx" \
  --pages "1-6" \
  --design-ref "7" \
  --output "提案書_関係図.pptx"
```

### 引数

| 引数 | 必須 | 説明 |
|------|------|------|
| `--input` | ✓ | 元PPTXファイルパス |
| `--pages` | ✓ | 変換対象ページ（例: `1-6` or `1,3,5`） |
| `--design-ref` | | デザイン基準ページ番号（書式を継承） |
| `--output` | | 出力ファイル（省略時は `--input` の拡張子前＋`_relation`） |
| `--dry-run` | | 図のMermaidコードを標準出力に表示（PPTXは書き出さない） |
| `--interactive` | | 変換前に各ページのパターン判定結果を表示して確認 |

### 出力モード

- **おすすめモード（default）**: 全対象ページのパターンを自動判定し、Mermaid図に変換して元PPTXに上書き。1ページに複数パターンが混在する場合は最適パターンを選択。
- **提案表示モード（`--interactive`）**: 自動判定結果とMermaidコードを表示、確認用。ヘッドレスでは default。

---

## 4. 実装計画

### Phase 1: コアロジック（このPR）

**ファイル**: `tools/ppt-to-relation.mjs`

1. **PPTX読み込み**: `officeparser` または `python-pptx` 呼び出しで箇条書きテキスト抽出
   - 各スライドのテキストボックスごと
   - 箇条書きレベル（インデント）の維持
2. **パターン検出器**: `lib/pattern-detect.mjs`
   - 信号語辞書（日本語・英語対応）
   - スコアリング → 最適パターン決定
3. **Mermaid生成器**: `lib/mermaid-gen.mjs`
   - パターン別テンプレート
   - 箇条書きテキストのノード割り当て
4. **PPTX書出し**: python-pptx を子プロセスで呼び出すか、power-pptx の diagram recipes を使用
5. **CLIラッパー**: `ppt-to-relation.mjs`

### Phase 2: デザイン継承（別PR）

- `--design-ref` で指定されたスライドのフォント・色・図形スタイルを判別
- 生成図に同じスタイルを適用

### Phase 3: オージャスト案件適用（別PR）

- ブース提案書の箇条書き→関係図変換のパイプライン
- 自社提案書の体裁ページをデザイン基準とした自動変換

---

## 5. 技術スタックの検討

| 方式 | 長所 | 短所 |
|------|------|------|
| **Node.js + officeparser** | 環境統一、追加ランタイム不要 | PPTX書出し弱い |
| **Node.js + Python子プロセス + python-pptx** | PPTX書出し強力 | Python環境依存 |
| **power-pptx (python-pptx fork)** | diagram recipes組み込みで直接図作成可能 | pip install power-pptx が必要 |
| **pptx-mcp (MCP server)** | Mermaid/PlantUML → PPTX直接変換 | MCP依存、汎用性低い |

**推奨: Python子プロセス方式**（`python-pptx` + `power-pptx` の diagram recipes）

理由:
- 既存の `python-pptx` エコシステムが最も成熟
- `power-pptx` の `horizontal_pipeline()` / `vertical_pipeline()` / `hub_and_spoke()` / `cycle()` で基本図を直接生成可能
- Mermaid変換が必要な複雑図は `pptx-mcp` の `add_mermaid_diagram()` を参考に自前実装

---

## 6. テスト計画

| テスト | 入力 | 期待結果 |
|--------|------|---------|
| プロセス検出 | "まずAを実施し、次にB、最後にC" | `flowchart LR` のA→B→C |
| 比較検出 | "オプションA vs オプションB" | 2列比較図 |
| 階層検出 | "XはA・B・Cから構成される" | ツリー図 |
| 循環検出 | "PDCAを繰り返す" | 循環図 |
| タイムライン | "Q1で調査、Q2で実装" | 水平タイムライン |
| PPTXラウンドトリップ | テスト用箇条書きPPTX | 図が挿入されたPPTXが出力される |

---

## 7. オージャストでの活用

### ユースケース: ブース提案書の視覚化

1. 営業がブース提案の箇条書きスライド（PPTX）を作成
2. `--design-ref` に自社提案書の体裁ページを指定
3. ツールが箇条書きを自動解析し、関係図に変換
4. 顧客向け提案書が視覚的にわかりやすくなる

### 期待効果

- 箇条書きスライド→図の手動変換工数を削減（営業1件あたり30分→5分）
- 提案書の視認性向上による受注率改善
- 複数案件への横展開が容易（共通テンプレート化）