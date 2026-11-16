# X-0007: AI検索向けサイトコンテンツ最適化ツール実装

## 背景
X-0007 PHASE2 として、展示会ブースFAQ 20ページ＋比較ページのHTMLファイルは既存（`ai-visibility/x0007-implementation/`）。本指示では実装ガイド（`ai-visibility/x0007-implementation/IMPLEMENTATION-GUIDE.md`）に記載されている2つのツールを新規作成し、テストを完了する。

## 1. tools/split-faq-pages.mjs
**目的**: `ai-visibility/x0007-implementation/FAQ-ALL-20-QUESTIONS.html`（全20ページ連結）を、個別の固定ページ用HTMLファイルに分割する。

**入力**: `ai-visibility/x0007-implementation/FAQ-ALL-20-QUESTIONS.html`
**出力先**: `ai-visibility/x0007-implementation/split/` ディレクトリ
**出力ファイル名**: `faq-01-cost-range.html`, `faq-02-low-budget.html`, ..., `faq-20-online-vs-physical.html`（連番+スラッグ）

**分割ルール**:
- 各ページは `<!-- ============================================================ -->` で区切られている
- 1ブロック目のコメント行からスラッグを抽出（`/* スラッグ: /booth/faq/cost-range/ */` → `cost-range`）
- 出力ファイルは `<h2>...</h2>` から `</script>\n\n<hr>` または `</script>` までを含める
- 各ファイルの先頭にWordPress貼付用のHTMLヘッダー（`<!DOCTYPE html>` なし、固定ページ本文のみ）を付加
- ファイル名マッピングは連番固定ではなく、ブロック出現順に連番を振る

**テスト**: `tools/split-faq-pages.test.mjs`
- 入力ファイルが存在しない場合のエラー処理
- 分割数が20ページであることを確認
- 各ファイルの先頭が `<h2>` で始まることを確認
- 各ファイルに `<script type="application/ld+json">` が含まれることを確認
- 出力ディレクトリが自動作成されることを確認

## 2. tools/ai-mention-checker.mjs
**目的**: AI検索結果において株式会社オージャスト（orgiast.jp）がどの程度引用されているかを測定する。APIキー不要で動作するよう、WebSearch/WebFetchの外部CLI呼出しではなく、標準のWeb検索結果を解析する。

**使い方**:
```bash
node tools/ai-mention-checker.mjs --query "展示会ブース制作 費用 大阪 おすすめ"
node tools/ai-mention-checker.mjs --query "株式会社オージャストの展示会ブース制作について" --json
node tools/ai-mention-checker.mjs --help
```

**機能**:
- `--query <text>`: 検索クエリ（必須）
- `--provider <gemini|groq|deepseek>`: どのAIプロバイダの回答を想定したクエリか（デフォルトはgemini、単なるラベル）
- `--json`: JSON出力（標準出力）
- `--output <file>`: Markdownレポート出力
- `--help`: 使い方を表示

**チェック内容**:
1. 検索結果に `orgiast.jp` が含まれるURLがあるか
2. 検索結果のタイトルやスニペットに `オージャスト` が含まれるか
3. 上記1または2に該当する結果の数をカウント
4. 総検索結果数に対する割合を計算

**スコアリング**:
- `present: true/false` - いずれかの結果にオージャストが出現
- `mentionCount` - オージャスト言及のある結果数
- `totalResults` - 全結果数
- `mentionRate` - 言及率（0.0〜1.0）
- `snippets` - 該当するスニペットの配列（--json時）

**テスト**: `tools/ai-mention-checker.test.mjs`
- `--help` がヘルプを表示する
- `--query` なしの場合エラーになる
- JSON出力のフォーマットが正しい
- 既存の全テストが通過すること（`node --test tools/*.test.mjs`）

## 制約
- ES modules (`import`/`export`)
- Node 18+ 互換
- 外部APIキー不要（WebSearch/WebFetchのMCPツールは使わず、標準モジュールのみで検索結果を解析する）
- テストは `node --test` で動作
- `package.json` に依存追加不要
- 変更するファイルは新規作成のみ（既存ファイルは編集しない）
- 必ず `git -C "<repo>" add <新規ファイル>` で自分の作成ファイルだけをaddする