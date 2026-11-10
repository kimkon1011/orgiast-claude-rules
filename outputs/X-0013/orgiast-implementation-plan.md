# オージャスト実装計画: 再現可能AIワークフロー

> 4週間でSEO記事生成・問合せ自動処理・LP生成の3パイプラインを構築

---

## Week 1: 基盤構築

### 目標
Docker Composeで全7ツールのローカル環境を構築し、相互接続を確認する。

### Day 1-2: 環境構築

```yaml
# docker-compose.yml 構成
services:
  litellm:      # LLM Gateway (port 4000)
  phoenix:      # Observability (port 6006)
  n8n:          # Workflow trigger (port 5678)
  postgres:     # LangGraph checkpoint store
```

**チェックリスト**:
- [ ] `docker compose up -d` で全コンテナ起動
- [ ] LiteLLM Proxy: `curl localhost:4000/models` → 設定済みモデル一覧
- [ ] Phoenix UI: `http://localhost:6006` → 空のプロジェクトページ
- [ ] n8n UI: `http://localhost:5678` → ワークフロー作成画面
- [ ] PostgreSQL: `psql -U langgraph -d langgraph` → テーブル作成確認

### Day 3-4: ツール接続確認

- [ ] LiteLLM → Phoenix: トレースがPhoenixに自動送信されることを確認
- [ ] LangGraph → PostgreSQL: チェックポイントがDBに保存されることを確認
- [ ] FastMCP: 最小MCPサーバー（`add`, `search`）がstdioで応答
- [ ] promptfoo: サンプル評価（`npx promptfoo eval`）が完走

### Day 5: 統合テスト

- [ ] n8n → LangGraph: n8n WebhookからLangGraphグラフが起動
- [ ] LangGraph → LiteLLM: LLM呼び出しがPhoenixにトレースされる
- [ ] FastMCP → LangGraph: MCPツールがグラフ内で正しく呼び出せる
- [ ] promptfoo → Phoenix: 評価結果がPhoenixにアノテーションとして記録される

---

## Week 2: SEO記事生成パイプライン

### 目標
毎朝6時に自動でSEO記事を生成し、WordPressに投稿するパイプラインの完成。

### 実装項目

| 項目 | ファイル | 説明 |
|------|---------|------|
| LangGraphグラフ | `workflows/seo-article-generator/graph.py` | 状態定義（State TypedDict）+ ノード定義 |
| Pydanticモデル | `workflows/seo-article-generator/schema.py` | `ArticleSchema(BaseModel): title, headings, body...` |
| FastMCPツール | `mcp-servers/wordpress/server.py` | WordPress REST APIラッパー |
| FastMCPツール | `mcp-servers/gsc/server.py` | Google Search Console APIラッパー |
| promptfoo評価 | `evals/seo-article-quality.yaml` | 品質評価テスト（80点ゲート） |
| n8nワークフロー | `n8n-workflows/seo-daily-schedule.json` | スケジュールトリガー＋Slack通知 |

### 品質基準（promptfoo評価）

```yaml
# evals/seo-article-quality.yaml の評価項目
tests:
  - assert:
      - type: llm-rubric
        value: "記事は展示会ブース制作に関連する具体的な内容を含んでいる"
      - type: contains
        value: "オージャスト"  # 自社名を含む
      - type: contains-all
        value: ["見出し", "導入", "本文", "まとめ"]  # 構造要件
      - type: cost
        threshold: 0.05  # 1記事あたり5セント以下
```

---

## Week 3: 問合せ自動処理パイプライン

### 目標
Gmail受信→自動分類→返信案生成→下書き保存のパイプライン完成。

### 実装項目

| 項目 | ファイル | 説明 |
|------|---------|------|
| LangGraphグラフ | `workflows/inquiry-processor/graph.py` | 分岐処理（conditional edges） |
| Pydanticモデル | `workflows/inquiry-processor/schema.py` | `InquiryCategory(enum)`, `ReplyDraft(BaseModel)` |
| FastMCPツール | `mcp-servers/gmail/server.py` | Gmail APIラッパー |
| n8nワークフロー | `n8n-workflows/inquiry-gmail-trigger.json` | Gmail受信トリガー |

### 品質基準

```yaml
tests:
  - assert:
      - type: llm-rubric
        value: "返信案は丁寧で、質問に正確に回答し、見積もり依頼には金額提示を促す"
      - type: javascript
        value: "output.category in ['estimate', 'consultation', 'other']"
      - type: cost
        threshold: 0.03
```

---

## Week 4: 運用最適化

### 目標
品質KPIの可視化、CI/CD統合、障害復旧手順確立。

### 項目

| 項目 | 内容 |
|------|------|
| Phoenixダッシュボード | 日次記事生成数・品質スコア推移・LLMコストの可視化 |
| CI/CD統合 | GitHub ActionsでPR時にpromptfoo評価を自動実行 |
| 障害復旧手順 | LangGraphチェックポイントからの復旧手順を文書化 |
| アラート設定 | Phoenixのアノテーションで品質スコア低下をSlack通知 |

---

## 費用見積もり

| 項目 | 月額費用 | 備考 |
|------|---------|------|
| LiteLLM経由LLM | $50-150 | 1日1記事＋問合せ処理。Gemini Flash＋GPT-6.1併用 |
| n8n Cloud（self-hostは無料） | $0（self-host） | Docker Composeで自社サーバー |
| Phoenix | $0（self-host） | Docker Compose。データ保持30日設定 |
| FastMCP | $0 | OSS |
| promptfoo | $0 | OSS CLI |
| LangGraph | $0 | OSS（LangSmithは有料だが今回は不使用） |
| **合計** | **$50-150/月** | |

> 既存のGitHub ActionsやVercel cronを置き換えるのではなく補完する位置づけ。n8nでスケジュール管理を統一することで、複数サービスのcron管理コストを削減。
