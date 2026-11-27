# X-0008: daily-seo-guide.mjs 実装指示

## 作るもの

CLIツール `tools/daily-seo-guide.mjs` とテスト `tools/daily-seo-guide.test.mjs`。

### コンセプト

GSCデータ（CSVエクスポートまたはgsc-keyword-finderのJSON出力）から「表示回数が多いがクリックが少ないキーワード」を見つけ、そのキーワードで高品質なSEOガイド記事を1本生成するCLIツール。生成されたガイドは、内部リンクとCTAを含む構造化マークダウンとして出力される。株式会社オージャストは展示会ブース制作関連キーワードを対象とする。

設計の詳細は `docs/ai-news-x0008-daily-seo-guide.md` を参照。

## 必須仕様

### 1. CLIインタフェース

```bash
# GSCキーワードファインダーのJSONを入力として使用
node tools/daily-seo-guide.mjs --gsc-json outputs/gsc-keywords.json

# GSCのCSVエクスポートを入力として使用
node tools/daily-seo-guide.mjs --gsc-csv data/gsc-export.csv

# 直接キーワードを指定（テスト用）
node tools/daily-seo-guide.mjs --keyword "1小間ブース デザイン 事例"

# レジャー初期化
node tools/daily-seo-guide.mjs --init-ledger

# 出力先指定
node tools/daily-seo-guide.mjs --gsc-json data.json --output-dir outputs/X-0008
```

### 2. オプション

| フラグ | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `--gsc-json` | 条件付き | - | gsc-keyword-finderのJSON出力ファイル（gsc-csvと排他） |
| `--gsc-csv` | 条件付き | - | GSCエクスポートCSV（gsc-jsonと排他） |
| `--keyword` | 条件付き | - | 直接キーワード指定（テスト用） |
| `--output-dir` | いいえ | "outputs/X-0008" | 出力ディレクトリ |
| `--ledger` | いいえ | "{output-dir}/ledger.json" | レジャーファイルのパス |
| `--init-ledger` | いいえ | false | レジャーの初期化のみ実行 |
| `--site-name` | いいえ | "株式会社オージャスト" | ガイド内で使う自社名 |
| `--service-pages` | いいえ | 組み込みリスト | 内部リンク先のサービスページ一覧（JSONファイル） |
| `--dry-run` | いいえ | false | 実際にAI呼び出しをせず、選択結果のみ表示 |
| `--force` | いいえ | false | 既にカバー済みのキーワードでも強制生成 |

### 3. 組み込みサービスページ（内部リンク用）

```js
const DEFAULT_SERVICE_PAGES = [
  { title: '展示会ブース制作 サービス一覧', url: 'https://www.orgiast.jp/booth/' },
  { title: 'ブース制作の料金プラン', url: 'https://www.orgiast.jp/booth/pricing/' },
  { title: '施工事例一覧', url: 'https://www.orgiast.jp/case-studies/' },
  { title: 'お問い合わせ', url: 'https://www.orgiast.jp/contact/' },
  { title: '小規模ブース制作のポイント', url: 'https://www.orgiast.jp/booth/small-booth/' },
  { title: 'ブースデザインの考え方', url: 'https://www.orgiast.jp/booth/design/' },
];
```

### 4. GSC CSVの解析

```js
function parseGscCsv(text) {
  // CSVをパースして配列に
  // ヘッダー: query, impressions, clicks, ctr, position (または クエリ, 表示回数, クリック数, CTR, 掲載順位)
  // 日本語/英語ヘッダーの両方に対応
  // 結果: [{ query, impressions, clicks, ctr, position }]
}
```

### 5. キーワード選択ロジック

```js
function selectKeyword(candidates, ledger) {
  // 1. レジャーから既にカバー済みのキーワードを除外
  // 2. 展示会ブース関連キーワードを優先（/展示会|ブース|イベント|出展|小間|装飾|設営|施工/）
  // 3. 優先度スコア = impressions * (1 - ctr) * (max(30, 100 - position) / 100) でソート
  // 4. 上位3件からランダムに1件選択（毎回同じにならないように）
  // 5. 展示会ブース関連がなければ全体から選択
  // 6. 未カバーがなければ --force を要求して終了
}
```

### 6. SEOガイド生成（llm-ask.mjs経由）

```js
// system prompt（日本語、SEO専門家として）
const SYSTEM_PROMPT = `あなたは展示会ブース制作のSEO専門家です。
以下のキーワードに対して、読者が知りたいこと・検索意図を満たす高品質なSEOガイドを1本書いてください。

【ガイドの構成】
1. タイトル（キーワードを含み、クリックしたくなるもの）
2. 導入文（100-150字。読者の課題に共感し、この記事がその解決になることを示す）
3. 見出し（H2）で区切られた本文（合計800-1200字）
4. 箇条書き・表を適宜使って読みやすく
5. まとめ（30-50字の結論＋次のアクション提示）

【SEO要件】
- タイトル・H2・導入文にキーワードを自然に含める
- 関連する共起語（類義語・周辺語）も使う
- 具体例・数字を入れる（信頼性向上）
- 専門用語を使う場合は簡単な説明を添える

【絶対禁止】
- 「まずは」「この記事では〜していきます」「最後までお読みいただき」などのブログ定型句
- AIらしい抽象的な表現（「多岐にわたる」「重要なポイント」などの中身のない言い回し）
- 長すぎる文章（1文60字以内を推奨）
- 事実と異なる数字・データの捏造`;

// user prompt のテンプレート
const USER_PROMPT_TEMPLATE = `キーワード: "${keyword}"
ターゲット読者: 展示会への出展を検討している企業の担当者
目的: このキーワードで検索している人の疑問・課題を解消し、具体的で役立つ情報を提供する

以下の形式でガイドを生成してください：

# {タイトル}

{導入文（100-150字）}

## {H2見出し1}
{本文}

## {H2見出し2}
{本文}

...

## まとめ
{結論＋次のアクション}`;
```

### 7. 内部リンクとCTAの自動挿入

生成されたガイド本文の末尾に、自動的に内部リンクセクションとCTAを追加:

```js
function appendInternalLinks(content, servicePages, keyword) {
  // ガイド本文の末尾に以下を追加:
  // 1. 関連サービスへの内部リンク（2-3件、ガイド内容と関連性が高いものを選択）
  // 2. CTA（「詳しくはお問い合わせください」＋リンク）
  
  // キーワードに含まれる単語とサービスページの関連性スコア
  // 例: キーワードに「デザイン」→ design ページを優先
  const KEYWORD_PAGE_MAP = {
    'デザイン': 'design',
    'デザイン': 'showroom', // 複数マッチあり
    '予算': 'pricing',
    '費用': 'pricing',
    '料金': 'pricing',
    '価格': 'pricing',
    '事例': 'case-studies',
    '実績': 'case-studies',
    '施工': 'case-studies',
    '小間': 'small-booth',
    '小規模': 'small-booth',
    '1小間': 'small-booth',
    '2小間': 'small-booth',
  };
  
  // 内部リンクセクション
  const section = '\n\n---\n\n## 関連サービス\n\n' +
    selectedPages.map(p => `- [${p.title}](${p.url}) — ${p.description}`).join('\n') +
    '\n\n---\n\n' +
    '### この記事を書いた人\n\n' +
    '株式会社オージャストは、展示会ブースの設計・制作・施工を一貫して手がける専門企業です。' +
    '金属加工の技術を活かしたオリジナルブースから、リユース可能なシステムブースまで、' +
    '予算や規模に合わせた最適な提案をいたします。\n\n' +
    '**まずは無料相談から** — お気軽にお問い合わせください。\n\n' +
    `[→ お問い合わせはこちら](${contactPage.url})`;
  
  return content + section;
}
```

### 8. レジャー管理

```js
// ledger.json の構造
{
  "version": 1,
  "lastUpdated": "2026-11-10T...",
  "guides": [
    {
      "date": "2026-11-10",
      "keyword": "1小間ブース デザイン",
      "slug": "1koma-booth-design",
      "file": "outputs/X-0008/guides/2026-11-10-1koma-booth-design.md",
      "impressions": 15000,
      "position": 45.2,
      "ctr": 0.02,
      "provider": "gemini"
    }
  ],
  "coveredKeywords": ["1小間ブース デザイン", ...]  // 簡易ルックアップ用
}

// 関数
function loadLedger(ledgerPath) { ... }
function saveLedger(ledgerPath, data) { ... }
function isKeywordCovered(ledger, keyword) { ... }  // 部分一致でも判定
function addGuideEntry(ledger, entry) { ... }
```

### 9. ファイル出力

ガイドファイル名: `{date}-{slug}.md`（slugはキーワードから生成: 日本語→ローマ字/英単語置換）
出力先: `{output-dir}/guides/`

```markdown
---
date: 2026-11-10
keyword: "1小間ブース デザイン"
impressions: 15000
position: 45.2
ctr: 2.0%
generated_by: daily-seo-guide (provider: gemini)
topic_category: 展示会ブース
---

# 1小間ブースのデザインで差をつける5つのポイント

{本文}

---

## 関連サービス

- [展示会ブース制作 サービス一覧](https://www.orgiast.jp/booth/)
- [小規模ブース制作のポイント](https://www.orgiast.jp/booth/small-booth/)
- [ブースデザインの考え方](https://www.orgiast.jp/booth/design/)

---

### この記事を書いた人

株式会社オージャストは、展示会ブースの設計・制作・施工を一貫して手がける専門企業です。

**まずは無料相談から** — お気軽にお問い合わせください。

[→ お問い合わせはこちら](https://www.orgiast.jp/contact/)
```

### 10. エラーハンドリング

- `--gsc-json` と `--gsc-csv` の両方指定 → エラー終了
- どちらも指定なし、かつ `--keyword` もなし → エラー終了
- レジャーファイルが空/破損 → 新規初期化して警告
- 未カバーのキーワードがない → 「すべての候補をカバー済みです。--force で強制生成」とメッセージ
- llm-ask.mjs が応答しない → プロバイダを変えてリトライ（計2回）
- 全プロバイダエラー → エラー終了

### 11. スラッグ生成

```js
function generateSlug(keyword) {
  // 日本語キーワードからURL-safeなスラッグを生成
  // ルール:
  // 1. 全角英数字→半角
  // 2. 英数字以外の文字→ハイフン
  // 3. 連続ハイフン→1つに
  // 4. 先頭/末尾のハイフン削除
  // 5. 40字以内にカット
  // 例: "1小間ブース デザイン 予算" → "1koma-booth-design-yosan"
  // 辞書: {"小間":"koma", "ブース":"booth", "デザイン":"design", "展示会":"exhibition", 
  //         "制作":"production", "施工":"construction", "予算":"budget", "費用":"cost",
  //         "事例":"case", "業界":"industry", "おすすめ":"recommended"}
}
```

## llm-ask.mjs の呼び方

```js
import { execFileSync } from 'node:child_process';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const llmAsk = path.join(toolsDir, 'llm-ask.mjs');

function generateContent(provider, systemPrompt, userPrompt) {
  const result = execFileSync(process.execPath, [
    llmAsk,
    '--provider', provider,
    '--system', systemPrompt,
    '--prompt', userPrompt,
    '--json',  // JSONモードで応答
  ], { encoding: 'utf8', timeout: 120000 });
  const parsed = JSON.parse(result.stdout.trim());
  return parsed.content || parsed.text || parsed.response || result.stdout.trim();
}
```

## プロバイダ選択

フォールバック順: `gemini → deepseek → groq`
第1候補がエラーなら第2候補に切り替え（計2回リトライ）

```js
const PROVIDERS = ['gemini', 'deepseek', 'groq'];
```

## テスト要件

`tools/daily-seo-guide.test.mjs` で以下をテスト:

1. **GSC CSVパース**: 日本語/英語ヘッダーのCSVを正しくパースできる
2. **GSC JSONパース**: gsc-keyword-finderのJSON出力を正しく読み込める
3. **キーワード選択**: 展示会ブース関連を優先する
4. **キーワード選択（重複回避）**: レジャーに既存のキーワードを除外する
5. **キーワード選択（全カバー）**: 全キーワードがカバー済みの場合の挙動
6. **スラッグ生成**: 日本語キーワードから適切なスラッグを生成
7. **内部リンク挿入**: ガイド本文の末尾に内部リンク・CTAが追加される
8. **レジャー管理**: 読込・保存・重複チェック
9. **CLI引数パース**: 各種フラグ
10. **エラー出力**: 必須フラグ不足・競合フラグ・全カバー
11. **全カバー時**: 「すべてカバー済み」メッセージ（テスト用にカバー済みキーワードを注入して確認）
12. **dry-runモード**: AI呼び出しをせず選択結果のみ表示

## 禁止事項

- Claude APIは使わない。`tools/llm-ask.mjs` 経由の安価AI（gemini/deepseek/groq）のみ。
- 外部npmパッケージの追加インストールは行わない（Node.js組み込みのみ、ただし googleapis は既存依存）。
- テストは `node --test` で実行可能であること。
- 実在するAPIキーや認証情報はコードに含めない。
- GSC APIを直接叩かない（入力はCSVエクスポートまたはgsc-keyword-finderのJSONのみ）。