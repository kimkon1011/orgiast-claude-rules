# 設計: X-0093 Code Modeで入力を削る

## 概要
`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` で Code Mode を有効化し、大量の検索結果から必要な箇所だけをコードで抽出してからLLMへ渡す。途中経過を丸ごと読ませない。

**オージャスト用途**: 過去展示会資料の一括検索で、対象ブースの寸法・部材・金額だけ抜き出してから提案文作成へ渡す。

## 実装アプローチ

### 1. 抽出ツール `tools/booth-data-extract.mjs`
- CLI: 構造化データ（JSON/CSV）から指定フィールドだけを抽出
- フィルター条件: ブースID / 日付範囲 / 部材タイプ
- 出力: 最小限の項目だけを含むJSON

### 2. 提案文書 `docs/ai-news-x0093-code-mode-input-reduction.md`
- 問題: 生の検索結果をそのままLLMに渡すとトークン浪費・ノイズ混入
- 解決: Code Mode + コード抽出で入力を1/10以下に削減
- 実装パターン: パイプライン設計（検索→抽出→LLM）

## 変更コンポーネント
| ファイル | 種別 | 説明 |
|---------|------|------|
| `docs/ai-news-x0093-code-mode-input-reduction.md` | 新規 | AIニュース提案文書 |
| `tools/booth-data-extract.mjs` | 新規 | 展示会データ抽出CLI |
| `tools/booth-data-extract.test.mjs` | 新規 | 単体テスト |
| `config/booth-data-schema.json` | 新規 | 抽出フィールド定義 |

## UI影響セクション
**UI変更なし**: 本件はCLIツールとドキュメントのみ。UI変更は一切ない。