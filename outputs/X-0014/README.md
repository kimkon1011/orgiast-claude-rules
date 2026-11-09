# X-0014 出力ディレクトリ解説

AIニュース提案 X-0014「スクショからAIウェブサイト生成」の実装レポートとユースケース分析を置く場所です。2026-11-09 の自動セッションで作成。

## ディレクトリ構造

```
outputs/X-0014/
├── README.md                         # 本解説
└── orgiast-use-case-analysis.md      # オージャスト固有の5ユースケース分析
```

## 関連リソース

| リソース | 説明 |
|---|---|
| `docs/ai-news-x0014-screenshot-website-generation.md` | 設計文書（ワークフロー・テンプレート構造・利点） |
| `tools/screenshot-website-builder.mjs` | WorkBuddy 投入用プロンプト生成CLI |
| `tools/screenshot-website-builder.test.mjs` | テストスイート（18 tests） |

## 検証結果

```
node --test tools/screenshot-website-builder.test.mjs  → 全18テスト pass
```

## 残り

- [ ] WorkBuddy Code タブの実環境での検証（別途契約・セットアップ後）
- [ ] 実際のブースデザインスクショを用いた生成テスト
- [ ] 生成されたページのアクセシビリティ・パフォーマンスレビュー
- [ ] ブランドガイドラインとの整合性チェック自動化

## X-0015 との関係

| タスク | 焦点 | 補完関係 |
|---|---|---|
| X-0014 | スクショからの**UI生成**（WorkBuddy Code タブ） | フロントエンド生成 |
| X-0015 | プロンプトの**静的先頭配置**（KVキャッシュ最大化） | プロンプト効率化 |
| X-0011 | SEOガイドの**定期自動生成** | SEO最適化と一体化 |