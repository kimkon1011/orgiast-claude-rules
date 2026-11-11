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

---

## 2026-11-11 追記: Grok Bot + Claude Code コーディング手順

X-0014 のサブプロジェクトとして、Grok Bot（xAI）をリサーチャー兼コミュニケーターに、
Claude Code / Codex を実装ワーカーにしたハイブリッドコーディング手順を追加。

### 追加成果物

| ファイル | 説明 |
|---|---|
| `docs/ai-news-x0014-grok-bot-coding-workflow.md` | 4 Phase 設計文書（リサーチ→実装→QA→デプロイ） |
| `tools/grok-bot-prompt-bridge.mjs` | Grok リサーチJSON→Claude Code実装プロンプト変換CLI |
| `tools/grok-bot-prompt-bridge.test.mjs` | テストスイート（10 tests） |
| `outputs/X-0014/sample-grok-research.json` | 自社ウェブサイト更新シナリオのサンプル |
| `outputs/X-0014/pr-body.md` | PR 本文 |

### 検証結果

```
node --test tools/grok-bot-prompt-bridge.test.mjs  → 全10テスト pass
```

### 差分（従来のWorkBuddy版との関係）

| 観点 | 従来（WorkBuddy） | 本WF（Grok Bot + Claude Code） | 補完関係 |
|---|---|---|---|
| スクショ→UI生成 | WorkBuddy Code タブ | — | 相互代替 |
| リサーチ→実装 | — | Grok Bot + Claude Code | 要件定義フェーズをカバー |
| モバイル介入 | 不可 | Grok アプリからフルコントロール可能 | — |
| QA | WorkBuddy 内蔵 | Grok Bot が第三者検証 | QA層の差別化 |
| WordPress 実装 | WorkBuddy（汎用） | Claude Code（WP特化） | WP特化は本WFが優位 |

両者は併用可能：Grok Bot でリサーチ→WorkBuddy でスクショ生成→Claude Code で WordPress 実装→Grok Bot で QA。

## X-0015 との関係

| タスク | 焦点 | 補完関係 |
|---|---|---|
| X-0014 | スクショからの**UI生成**（WorkBuddy） + **Grok Bot連携コーディング** | フロントエンド生成＋リサーチ駆動開発 |
| X-0015 | プロンプトの**静的先頭配置**（KVキャッシュ最大化） | プロンプト効率化 |
| X-0011 | SEOガイドの**定期自動生成** | SEO最適化と一体化 |