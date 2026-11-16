# X-0033 出力ディレクトリ解説

AIニュース提案 X-0033「質問抽出で一次情報コンテンツ作成」の実装レポートを置く場所です。2026-11-16 の自動セッションで作成。

実装手法は [docs/ai-news-x0045-expert-question-article.md](../../docs/ai-news-x0045-expert-question-article.md)（NYSEO式 専門家質問法）に基づく。

## ディレクトリ構造

```
outputs/X-0033/
└── README.md               # 本解説
```

## 設計書

| ファイル | 説明 |
|---|---|
| `docs/ai-news-x0045-expert-question-article.md` | NYSEO式20〜25問ヒアリング × AI生成で差別化コンテンツ（2026-11-14作成） |

## 実装ツール

| ツール | 説明 | テスト |
|---|---|---|
| `tools/interview-article-gen.mjs` | 専門家インタビュー質問生成＋回答→SEO記事生成 | `tools/interview-article-gen.test.mjs` (4 tests, all pass) |

### interview-article-gen.mjs の機能

**2つのモード:**

1. **`--mode questions`** — ブース制作スタッフ向けの構造化インタビュー質問セット（24問・6カテゴリ）をLLM生成
2. **`--mode article`** — 回答JSONファイルからSEO記事を生成（タイトル・リード・h2セクション・FAQ・メタデータ）

**質問カテゴリ配分（X-0045 準拠）:**

| カテゴリ | 質問数 | 目的 |
|---------|--------|------|
| 経験・実績 | 5問 | 実体験の具体化（いつ・どこで・誰と） |
| 課題・失敗 | 5問 | 独自の困難と克服エピソード |
| 数字・データ | 4問 | 検証可能な定量情報 |
| 比較・対比 | 4問 | 差別化ポイントの明確化 |
| トレンド・変化 | 4問 | 業界知見・将来予測 |
| アドバイス | 2問 | 読者への実用的示唆 |

**記事生成の品質ルール:**
- 公開情報や一般知識で補完しない（インタビュー回答のみを情報源とする）
- 具体的な数字・固有名詞・事例は引用符で囲む
- E-E-A-Tを高めるため経験に基づく記述を優先
- 一般論・誇張表現を禁止

**サンプルデータ:** `sampleQaPairs()` に23問分の模擬QA（展示会ブース制作スタッフ想定）を内蔵

## 使い方

```bash
# 質問生成
node tools/interview-article-gen.mjs --mode questions --topic "展示会ブース制作" --persona "施工スタッフ"

# 記事生成（回答JSONから）
node tools/interview-article-gen.mjs --mode article --answers ./answers.json --output ./article.md

# サンプル実行
node tools/interview-article-gen.mjs --sample
```

### 回答JSONのフォーマット

```json
[
  {
    "question": "質問文？",
    "answer": "回答文（具体的な事例・数字を含む）"
  }
]
```

## 既存の関連ツール

| ツール | 関連性 |
|---|---|
| `tools/ai-query-extract.mjs` | X-0005: テキストから疑問文系・依頼文系を抽出しLLMOクエリを生成 |
| `rebooth-customer-interview` | Reブースのお客様インタビュー記事生成スキル（類似別系統） |

## 処理フロー

```
トピック・ペルソナ設定
        ↓
LLMによる20〜25問の質問生成（6カテゴリ）
        ↓
【人間によるインタビュー実施】（このツールの範囲外）
        ↓
回答をQAペアのJSONとして保存
        ↓
LLMによる記事生成（インタビュー回答のみを情報源に）
        ↓
人間による校閲・事実確認（チェックリスト厳守）
        ↓
SEOメタデータ付与 → 公開
```

## 残り

- [ ] 実際のブース制作スタッフへのインタビューで本ツールを試用し、質問品質を検証
- [ ] 記事生成プロンプトのバージョン管理と継続的改善
- [ ] 回答音声の文字起こし→QA JSON変換パイプラインの追加検討
- [ ] Web UI（簡易フォーム）の追加検討

---

## 2026-11-16 初回作成

X-0033「質問抽出で一次情報コンテンツ作成」の実装として `tools/interview-article-gen.mjs` + テストを作成。
手法は docs/ai-news-x0045-expert-question-article.md（NYSEO式専門家質問法）に基づく。