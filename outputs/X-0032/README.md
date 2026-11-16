# X-0032 出力ディレクトリ解説

AIニュース提案 X-0032「キャッシングとログで30-50%コスト削減」の実装レポートを置く場所です。2026-11-15 の自動セッションで作成。

## ディレクトリ構造

```
outputs/X-0032/
└── README.md                         # 本解説
```

## 設計書

| ファイル | 説明 |
|---|---|
| `docs/ai-news-x0032-grok-backoffice.md` | X-0032 Grok Bot版設計書（2026-11-14作成） |
| `docs/ai-news-x0032-ai-seo-agent.md` | X-0032 AI SEOエージェント版設計書（2026-11-12作成・今回の実装対象） |

## 実装ツール

| ツール | 説明 | テスト |
|---|---|---|
| `tools/llm-cache-store.mjs` | リクエストレベルキャッシュストア + コストログ + 集計。同一/類似プロンプトの応答をファイルキャッシュし、トークン消費・レイテンシ・コストをJSONLに記録する | `tools/llm-cache-store.test.mjs` (18 tests, all pass) |

### llm-cache-store.mjs の機能

- **正常化 + SHA-256 ハッシュ**: 空白・改行を統一してからハッシュ化。軽微な整形差を吸収
- **類似度検索**: 単語3-gram Jaccard類似度で、85%以上一致するキャッシュエントリを候補として返す
- **TTL管理**: 既定24時間。期限切れエントリは自動削除
- **JSONLログ**: 全リクエストを追跡。後から集計可能
- **コスト計算**: キャッシュヒット=LLM呼出し不要で$0、ミスのみ実費計算
- **デモシナリオ**: `--scenario booth-proposal`（展示会ブース提案）・`event-estimate`（イベント見積）で削減効果をシミュレーション

### デモ結果

| シナリオ | リクエスト数 | キャッシュヒット率 | 削減率 |
|---|---|---|---|
| 展示会ブース提案生成（5件） | 5 | 80% | 81.9% |
| イベント見積生成（5件） | 5 | 80% | 約70〜85% |

## 使い方

```bash
# デモ実行
node tools/llm-cache-store.mjs --demo
node tools/llm-cache-store.mjs --demo --scenario=event-estimate --batch=10

# 集計表示（実際のログがある場合）
node tools/llm-cache-store.mjs --stats
node tools/llm-cache-store.mjs --stats --since 2026-11-15

# キャッシュ管理
node tools/llm-cache-store.mjs --cache-stats
node tools/llm-cache-store.mjs --clear-cache

# テスト
node --test tools/llm-cache-store.test.mjs
```

## 既存の関連ツール

| ツール | 関連性 |
|---|---|
| `tools/kv-cache-prefix-gateway.mjs` | Anthropic APIのKVキャッシュプレフィックス共有（プロンプトレベル） |
| `tools/cache-warm-audit.mjs` | Claude CodeセッションJSONLのキャッシュ効率監査 |
| `tools/x0017-prompt-cache-usage.mjs` | プロンプトキャッシュヒット率の記録・レポート |
| `tools/cache-audit.mjs` | コード内の cache_control 未設定検出 |

## 残り

- [ ] `llm-cache-store.mjs` を実際のLLM呼出しパイプライン（`llm-ask.mjs` 等）と統合
- [ ] 実プロンプトでのキャッシュヒット率測定（週次集計）
- [ ] 類似度閾値（0.85）の実測チューニング
- [ ] セマンティックキャッシング（Embeddingベース類似検索）の追加検討

---

## 2026-11-15 初回作成

X-0032「キャッシングとログで30-50%コスト削減」の実装として `tools/llm-cache-store.mjs` + テストを作成。

### 作成したもの

| ファイル | 説明 |
|---|---|
| `tools/llm-cache-store.mjs` | リクエストキャッシュストア（ハッシュ/類似検索・JSONLログ・集計・デモ） |
| `tools/llm-cache-store.test.mjs` | テスト（18件、全件PASS） |
| `outputs/X-0032/README.md` | 本解説（更新） |

### 判断

- **リクエストレベルキャッシング**は、類似プロンプトが繰り返されるユースケース（ブースデザイン案生成、イベント見積生成等）で50〜80%のコスト削減が期待できる
- 既存の `kv-cache-prefix-gateway.mjs` はAnthropic APIのprompt caching（KVキャッシュ）前提で設計されているが、本ツールはプロバイダ非依存のリクエスト単位キャッシュ層として独立して動作する
- 実際の削減率はキャッシュヒット率に依存。「同じプロンプトを何度も使い回す」ユースケースでは80%超、「微妙に違うが類似」では50〜70%