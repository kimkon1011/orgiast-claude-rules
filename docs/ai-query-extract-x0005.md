# X-0005: 正規表現で疑問・依頼文をAIクエリ抽出

## 概要

日本語テキスト（サイトの問い合わせ文・メッセージフォーム入力等）から、**疑問文系**と**依頼文系**の文を正規表現で抽出し、LLMO（Large Language Model Optimization）向けの明確なAIクエリとして構造化するツール。

## ツール

- `tools/ai-query-extract.mjs` — 抽出エンジン本体
- `tools/ai-query-extract.test.mjs` — テスト（43件・全通過）

## 使い方

### CLI

```bash
# ファイルから
node tools/ai-query-extract.mjs --file inquiry.txt

# テキストを直接指定
node tools/ai-query-extract.mjs --text "ブースの見積もりはいくらですか？"

# 標準入力から（パイプ）
cat inquiry.txt | node tools/ai-query-extract.mjs

# サンプル実行
node tools/ai-query-extract.mjs --sample

# JSON出力
node tools/ai-query-extract.mjs --text "見積もりください" --json
```

### プログラムから

```js
import { extractQueries } from './tools/ai-query-extract.mjs';

const result = extractQueries(`
  来年の展示会に出展を検討しています。
  ブースの見積もりはいくらですか？
  デザインの相談もしたいです。
`);

console.log(result.summary);
// { total: 3, questions: 1, requests: 2, top_query: "ブースの見積もりはいくらですか？" }

console.log(result.queries);
// [
//   { text: "デザインの相談もしたいです。", type: "request", subtype: "consultation", priority: 18, ... },
//   { text: "ブースの見積もりはいくらですか？", type: "question", subtype: "price_inquiry", priority: 9, ... },
//   ...
// ]
```

### エクスポートされた関数

| 関数 | 説明 |
|------|------|
| `extractQueries(text, options?)` | テキストから疑問・依頼文を抽出し構造化 |
| `splitSentences(text)` | 日本語テキストを文単位に分割 |
| `isQuestion(sentence)` | 疑問文か判定 |
| `isRequest(sentence)` | 依頼文か判定 |
| `matchPatterns(sentence, patterns)` | 文にマッチするパターンを全件返す |
| `matchDomainPatterns(sentence)` | ドメイン特化パターン（展示会）にマッチ |
| `normalizeQuery(text)` | AIクエリとして正規化 |
| `containsJapanese(text)` | 日本語文字を含むか判定 |

## 抽出パターン

### 疑問文系（13パターン）

| パターンID | 説明 | 正規表現の特徴 | 優先度 |
|-----------|------|--------------|--------|
| `question_end_ka` | 疑問終助詞「か」 | `(ですか\|ますか\|でしょうか\|んですか)末尾` | 9 |
| `question_end_question_mark` | 疑問符「？」 | `末尾の？` | 9 |
| `question_end_kana` | 「かな/かしら」 | `(かな\|かしら\|っけ)末尾` | 7 |
| `question_word_price` | 金額・料金 | `(いくら\|料金\|費用\|見積もり)+(ですか\|か\|を教えて)` | 8 |
| `question_word_how_many` | 数量・程度 | `(いくつ\|どのくらい\|何個\|何人)` | 7 |
| `question_word_which` | 選択・特定 | `(どの\|どちら\|どれ\|どんな\|何の)` | 7 |
| `question_word_why` | 理由・原因 | `(なぜ\|なんで\|どうして)` | 6 |
| `question_word_how` | 方法・手段 | `(どうやって\|どのように\|どうすれば)` | 7 |
| `question_word_when` | 時期・期限 | `(いつ\|納期\|締切\|日程)+(か\|ですか\|を教えて)` | 8 |
| `question_word_where` | 場所・所在 | `(どこ\|どちら)+(ですか\|か\|はどこ)` | 6 |
| `question_word_what` | 内容・対象 | `(何が\|何を\|とは\|って何)` | 7 |
| `question_word_who` | 人物 | `(誰\|どなた\|担当者)+(ですか\|か\|は誰)` | 7 |

### 依頼文系（13パターン）

| パターンID | 説明 | 正規表現の特徴 | 優先度 |
|-----------|------|--------------|--------|
| `request_kudasai` | 「ください」 | `(ください\|下さい)末尾` | 9 |
| `request_onegai` | 「お願い」 | `お願い(します\|致します\|できますか)` | 9 |
| `request_hoshii` | 「ほしい」 | `(してほしい\|していただきたい)` | 8 |
| `request_irai` | 依頼名詞 | `(依頼\|ご依頼)` | 8 |
| `request_moushikomi` | 申込 | `(申込\|申し込み\|エントリー\|申請)` | 9 |
| `request_yoyaku` | 予約 | `(予約\|空き状況)` | 8 |
| `request_soudan` | 相談 | `(相談\|打ち合わせ\|ヒアリング)` | 8 |
| `request_toiawase` | 問い合わせ | `(問い合わせ\|照会\|質問)` | 7 |
| `request_mitumori` | 見積もり依頼 | `(見積もり)+(ください\|お願い\|依頼\|希望\|送っ)` | 9 |
| `request_shiritai` | 知りたい・教えて | `(知りたい\|教えて\|ご教示\|伺いたい)` | 8 |
| `request_tai` | 「したい」 | `(したい\|希望\|要望\|検討)` | 7 |
| `request_contact` | 連絡依頼 | `(連絡\|ご連絡ください)` | 8 |
| `request_souhin` | 送付依頼 | `(送付\|資料請求\|カタログ)` | 8 |

### ドメイン特化パターン（展示会ブース業界）

| パターンID | 説明 | 例 |
|-----------|------|-----|
| `domain_booth_size` | ブースサイズ | 小間、ブースサイズ、何小間、9m² |
| `domain_booth_design` | デザイン | デザイン、設計、図面、レイアウト、施工 |
| `domain_equipment` | 備品・機材 | レンタル、家具、照明、音響 |
| `domain_event` | イベント | 展示会、見本市、フェア、博覧会 |
| `domain_logistics` | 運営・物流 | 設営、搬入、搬出、配送 |
| `domain_interpretation` | 通訳・案内 | 通訳、アテンダント、スタッフ |

## 出力形式

```json
{
  "queries": [
    {
      "text": "ブースの見積もりはいくらですか？",
      "type": "question",
      "subtype": "price_inquiry",
      "patterns": ["question_word_price", "question_end_question_mark"],
      "domain": [],
      "priority": 9,
      "normalized": "ブースの見積もりは金額ですか？"
    }
  ],
  "summary": {
    "total": 1,
    "questions": 1,
    "requests": 0,
    "top_query": "ブースの見積もりはいくらですか？"
  }
}
```

### 優先度ルール

- **依頼文系（request）**: 基本優先度10 + マッチしたパターンの最大優先度（実用優先）
- **疑問文系（question）**: マッチしたパターンの最大優先度のみ
- 疑問と依頼の両方にマッチした場合は**依頼**として扱う（actionable優先）
- 出力は優先度降順

### サブタイプ一覧

| type | subtype | 説明 |
|------|---------|------|
| `request` | `price_request` | 価格・見積もり依頼 |
| `request` | `application` | 申込・予約 |
| `request` | `consultation` | 相談・問い合わせ |
| `request` | `general_request` | 一般的な依頼（ください・お願い） |
| `request` | `contact_request` | 連絡・送付依頼 |
| `request` | `desire` | 希望・要望 |
| `question` | `price_inquiry` | 価格・数量の疑問 |
| `question` | `timing_inquiry` | 時期・期限の疑問 |
| `question` | `location_inquiry` | 場所の疑問 |
| `question` | `selection_inquiry` | 選択の疑問 |
| `question` | `reason_inquiry` | 理由の疑問 |
| `question` | `method_inquiry` | 方法の疑問 |
| `question` | `definition_inquiry` | 定義の疑問 |
| `question` | `contact_inquiry` | 連絡先の疑問 |

## LLMO（Large Language Model Optimization）での活用

抽出したクエリを以下の優先度でコンテンツ優先度付けに使う：

1. **依頼文系（高優先）**: 見積もり依頼、申込、資料請求 → すぐに回答が必要なコンテンツ
2. **疑問文系（中優先）**: 価格問い合わせ、時期確認、方法問い合わせ → 情報提供で解決できるコンテンツ
3. **ドメイン特化パターン**: 展示会ブース関連 → 業界特化のFAQ・説明ページとして充実させる

## 開発

```bash
# テスト実行
node --test tools/ai-query-extract.test.mjs

# テストカバレッジ
node --test --experimental-test-coverage tools/ai-query-extract.test.mjs
```
