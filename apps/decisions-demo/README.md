# Gemini Decision 1 デモ

Gemini Decisions API（`gemini-decision-1`）を使用した、出力トークン課金ゼロの判定デモ。

## 前提条件

- Node.js 18+
- `@google/genai` パッケージ（最新版、v1beta API 対応）
- Gemini API キー（Google AI Studio で取得）

## セットアップ

```bash
# 依存関係のインストール
cd apps/decisions-demo
npm install @google/genai

# API キーの設定
export GEMINI_API_KEY="your-api-key-here"
```

API キーは [Google AI Studio](https://aistudio.google.com/) で取得できます。無料枠あり。

## 実行

```bash
node apps/decisions-demo/decisions-demo.mjs
```

## デモ内容

3 つのユースケースを実行します：

### 1. 問い合わせ自動分類（3 ケース）

展示会来場者からの問い合わせメールを以下の観点で分類：
- 見積依頼か？（noul）
- キャンセルか？（noul）
- 緊急対応が必要か？（noul）
- 問い合わせ種別（choice: 見積依頼/在庫確認/キャンセル/ブース仕様/その他）

### 2. ブース仕様確認（2 ケース）

会場のブース仕様書を読み、条件合致をチェック：
- 幅 3.6m 以内か？（noul）
- 奥行 3.6m 以内か？（noul）
- 高さ 2.5m 以内か？（noul）
- 耐荷重 500kg/m² 以上か？（noul）
- 電源 1.5kVA 以上か？（noul）
- 全条件を満たすか？（noul）

### 3. 顧客要件合致チェック（2 ケース）

顧客のヒアリングシートと提案書を比較：
- 予算範囲内か？（noul）
- 日程合致か？（noul）
- 必須要件を満たすか？（noul）
- 総合適合度（score: 低/中/高）

## 注意事項

- Decisions API は v1beta のみの提供です。本番適用は GA 後に行ってください。
- コンテキストキャッシュ、バッチ API、Flex/Priority には対応していません。
- 確信度 0.90 未満の判定は人手確認を推奨します。
