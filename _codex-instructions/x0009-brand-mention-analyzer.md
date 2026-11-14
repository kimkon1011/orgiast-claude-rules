# X-0009: brand-mention-analyzer.mjs 実装指示

## 作るもの

CLIツール `tools/brand-mention-analyzer.mjs` とテスト `tools/brand-mention-analyzer.test.mjs`。

### コンセプト

商業的質問（例: "展示会ブース制作 おすすめの会社は？"）を複数の安価AI（gemini/deepseek/groq）に同時に送信し、各AIの回答中にどの企業ブランドが言及されているかを抽出・比較するツール。自社ブランド（オージャスト）の有無と競合の言及状況を一覧化し、欠けているAI引用言及を埋めるコンテンツ戦略の判断材料を提供する。

設計の詳細は `docs/ai-news-x0009-brand-mention-analyzer.md` を参照。

## 必須仕様

### 1. CLIインタフェース

```bash
# 単一質問
node tools/brand-mention-analyzer.mjs --question "展示会ブース制作 おすすめの会社は？" --output markdown

# 競合指定
node tools/brand-mention-analyzer.mjs --question "展示会ブース デザイン" --competitors "リブース,クラフト,ブーステック" --output json

# CSV一括
node tools/brand-mention-analyzer.mjs --questions-file data/questions.csv --output json
```

### 2. オプション

| フラグ | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `--question` | 条件付き | - | 分析する質問（questions-file と排他） |
| `--questions-file` | 条件付き | - | 質問CSVファイル（question と排他） |
| `--brand` | いいえ | "オージャスト" | 自社ブランド名 |
| `--competitors` | いいえ | "リブース" | カンマ区切り競合ブランド一覧 |
| `--providers` | いいえ | "gemini,deepseek,groq" | 問い合わせ先AIプロバイダ |
| `--output` | いいえ | "markdown" | 出力形式 markdown/json |

### 3. 処理フロー

1. 質問をパース（単一またはCSV）
2. 各プロバイダに `tools/llm-ask.mjs` 経由で同質問を送信
   - system prompt: "あなたは有益な情報を提供するアシスタントです。以下の質問に対して、具体的な企業名やサービス名を含めて回答してください。回答の末尾には、参考にした情報源のURLがあれば列挙してください。"
   - user prompt: `--question` の値
3. 各回答からブランド名を検出:
   - 完全一致（ブランド名が文字列として含まれる）
   - 部分一致（「オージャスト株式会社」など）
   - URLドメイン一致（ブランドのドメインを含むURL）
4. 引用URLを抽出（URLパターン正規表現）
5. クロス集計（ブランド × AIプロバイダ）
6. レポート生成（markdown or JSON）

### 4. llm-ask.mjs の呼び方

```js
import { execFileSync } from 'node:child_process';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const llmAsk = path.join(toolsDir, 'llm-ask.mjs');

function askProvider(provider, systemPrompt, userPrompt) {
  const result = execFileSync(process.execPath, [
    llmAsk,
    '--provider', provider,
    '--system', systemPrompt,
    '--prompt', userPrompt,
  ], { encoding: 'utf8', timeout: 60000 });
  return result.stdout.trim();
}
```

### 5. ブランド検出

```js
// 組み込みブランドリスト（常時チェック）
const DEFAULT_BRANDS = ['オージャスト', 'リブース'];

// ユーザー指定の競合を追加
// 検出: 完全一致、部分一致（前方/後方/中間部分一致も可）、URLドメイン一致
function detectBrands(text, brands) {
  return brands.map(brand => ({
    brand,
    exactMatch: text.includes(brand),
    partialMatch: /* 「オージャスト」→「オージャスト株式会社」「㈱オージャスト」など */,
    urlMatch: /* ブランドに紐づくドメインがtext中のURLに含まれる */,
    mentioned: /* いずれかの条件でtrue */,
    count: /* 出現回数 */,
  }));
}
```

部分一致ルール:
- ブランド名がそのまま含まれる
- ブランド名 + 「株式会社」「㈱」「(株)」が続く
- 「株式会社」+ ブランド名
- 全角/半角の違いを吸収

URLドメイン一致ルール（組み込み）:
- オージャスト: orgiast.jp
- リブース: rebooth.co.jp

### 6. 出力形式

#### markdown出力（デフォルト）

```markdown
# AI引用ブランド言及分析レポート

> 質問: "展示会ブース制作 おすすめの会社は？"

## 質問結果サマリー
| AIプロバイダ | 言及ブランド数 | 自社({brand}) | 競合言及 | 引用URL数 |
|-------------|:------------:|:-------------:|:--------:|:--------:|
| gemini      | 4            | ❌ なし        | リブース | 3 |
| deepseek    | 3            | ✅ あり        | リブース | 2 |
| groq        | 5            | ❌ なし        | リブース, クラフト | 4 |

## ブランド別クロス集計
| ブランド | gemini | deepseek | groq | 出現率 |
|---------|:-----:|:--------:|:----:|:-----:|
| リブース | ✅ | ✅ | ✅ | 3/3 |
| オージャスト | ❌ | ✅ | ❌ | 1/3 |

## ギャップ分析
- 自社({brand}): N AI 中 M AI のみ言及
- 競合リブース: 全AIに出現
- 優先アクション: [AIが引用しやすいコンテンツ施策の提案]
```

#### JSON出力

```json
{
  "question": "展示会ブース制作 おすすめの会社は？",
  "timestamp": "2026-11-10T...",
  "results": [
    {
      "provider": "gemini",
      "responseSnippet": "...",
      "brands": [
        { "brand": "オージャスト", "mentioned": false, "exactMatch": false, "partialMatch": false, "urlMatch": false, "count": 0 },
        { "brand": "リブース", "mentioned": true, "exactMatch": true, "partialMatch": false, "urlMatch": false, "count": 2 }
      ],
      "citedUrls": ["https://...", "https://..."]
    }
  ],
  "crossTab": {
    "オージャスト": { "gemini": false, "deepseek": true, "groq": false, "appearanceRate": "1/3" },
    "リブース": { "gemini": true, "deepseek": true, "groq": true, "appearanceRate": "3/3" }
  },
  "gapAnalysis": {
    "selfBrand": "オージャスト",
    "selfMentionCount": 1,
    "totalProviders": 3,
    "topCompetitors": ["リブース"],
    "priorityActions": ["施工事例ページの強化", "「おすすめ」クエリに対応する比較記事作成"]
  }
}
```

### 7. 外部依存

- `tools/llm-ask.mjs` — 既存ツール。--provider / --system / --prompt フラグを受け付ける
- Node.js 18+ 組み込みモジュールのみ（追加npm不要）

### 8. エラーハンドリング

- 特定プロバイダが応答しない/エラーの場合は該当プロバイダをスキップし、レポートに「エラー」と記載
- 全プロバイダがエラーの場合は終了コード1でエラー終了
- `--question` と `--questions-file` の両方が指定された場合はエラー終了
- どちらも指定されていない場合はエラー終了

### 9. テスト要件

`tools/brand-mention-analyzer.test.mjs` で以下をテスト:

1. **ブランド検出（完全一致）**: 回答テキストにブランド名が含まれている場合、mentioned=true
2. **ブランド検出（部分一致）**: 「オージャスト株式会社」→「オージャスト」が検出される
3. **ブランド検出（URL一致）**: URLに orgiast.jp が含まれる場合 → ブランド検出
4. **ブランド未検出**: テキストにブランド名がない場合、mentioned=false
5. **クロス集計**: 複数プロバイダの結果を正しく集計
6. **CLI引数パース**: 各種フラグのパース
7. **エラー出力**: 必須フラグ不足でエラーになる
8. **競合ブランド追加**: --competitors で指定したブランドが検出対象になる
9. **質問CSV読み込み**: 複数質問の処理
10. **JSON出力フォーマット**: 出力がパース可能なJSONであること

## 禁止事項

- Claude APIは使わない。tools/llm-ask.mjs 経由の安価AI（gemini/deepseek/groq）のみ。
- 外部npmパッケージの追加インストールは行わない（Node.js組み込みのみ）。
- テストは node --test で実行可能であること。
- 実在するAPIキーや認証情報はコードに含めない。