# X-0025: オープンソースでAIコーディングエージェントの検証ワークフロー

> 作成: 2026-11-13 | 更新: 2026-11-13

## 概要

AIコーディングエージェント（Claude Code, Codex等）が生成したコードを、検証・回復・実結果追跡まで含めた**再現可能なパイプライン**で評価するワークフローを構築する。以下のOSSツールを組み合わせ、実行→検証→回復→追跡のサイクルを自動化する。

### 対象ツール群

| カテゴリ | ツール | 役割 | ライセンス | Stars |
|----------|--------|------|------------|-------|
| 実行エンジン | Claude Agent SDK | 動的ワークフロー（JSスクリプトでサブエージェント並列実行） | Proprietary (free) | — |
| 実行エンジン | LangGraph | グラフベース永続ワークフロー（StateGraph, チェックポイント） | MIT | 10k+ |
| 評価・検証 | Promptfoo | CLI駆動評価（アサーション, CI/CD品質ゲート, MCP統合） | MIT | 25.5k |
| 評価・検証 | OpenAI Evals | 共有ベンチマークレジストリ, カスタムeval登録 | MIT | 19.5k |
| 評価・検証 | OpenEvals (Phoenix Evals) | LLM-as-a-judge評価器, カスタムルーブリック | Elastic | 3k+ |
| トレース・監視 | Langfuse | トレーシング, プロンプト管理, 実験管理, オンラインeval | MIT | 35.1k |
| トレース・監視 | Arize Phoenix | OpenTelemetryベーストレース, エージェントパス評価, セルフホスト | Elastic | 8k+ |

## パイプライン設計: 実行 → 検証 → 回復 → 追跡

### 全体アーキテクチャ

```
┌──────────────────────────────────────────────────────────────────┐
│  Orchestrator (Claude Agent SDK / LangGraph)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │
│  │  Plan    │→│ Generate │→│ Verify  │→│ Recover      │   │
│  │ (仕様→   │  │ (AIコー   │  │ (テスト, │  │ (失敗箇所再   │   │
│  │  タスク)  │  │  ド生成)  │  │   lint)  │  │  生成+検証)   │   │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘   │
│                                           ↓                      │
│                                    ┌──────────────┐              │
│                                    │  結果追跡    │              │
│                                    │ (Langfuse/   │              │
│                                    │  Phoenix)    │              │
│                                    └──────────────┘              │
└──────────────────────────────────────────────────────────────────┘
```

### Phase 1: 計画 (Plan)
- 人間が仕様・設計を定義（アーキテクチャ所有権を維持）
- エージェントがタスク分解し依存関係を解決
- **ツール**: Claude Agent SDK (dynamic workflows) / LangGraph StateGraph

### Phase 2: 生成 (Generate)
- 各タスクをAIエージェント（Claude Code / Codex）が実装
- ファイル生成・編集を実行
- **ツール**: Claude Code CLI / codex-do.mjs

### Phase 3: 検証 (Verify)
- 静的検証: lint, typecheck, フォーマット
- 動的検証: ユニットテスト, 結合テスト
- AI検証: LLM-as-a-judgeでコード品質・仕様充足性を評価
- 品質ゲート: 合格率閾値を超えないと次フェーズへ進めない
- **ツール**: Promptfoo (アサーション + CI/CD品質ゲート), OpenEvals (カスタムルーブリック)

### Phase 4: 回復 (Recover)
- 失敗したタスクは、エラー内容を添えて再生成
- チェックポイントから再開（成功済みタスクは再実行しない）
- 上限回数に達したら人間へエスカレーション
- **ツール**: LangGraph checkpointer (checkpoint/thred_id), Promptfoo MCP (再実行)

### Phase 5: 追跡 (Track)
- 各実行のトレースを収集（トークン消費・レイテンシ・成功率）
- コスト監視（モデル別・タスク別）
- 実績データをダッシュボードで可視化
- **ツール**: Langfuse (トレース+スコアリング), Arize Phoenix (エージェントパス評価)

## 各ツールの詳細

### Claude Agent SDK — 動的ワークフローオーケストレータ

最新（v0.2.90+）のClaude Agent SDKは、JavaScriptで記述した動的ワークフローを実行できる。サブエージェント（完全なClaude Codeエージェント）を並列・段階的に起動可能。

**キー機能:**
- 最大16エージェントの同時実行、1ラン最大1,000エージェント
- サブエージェントごとに異なるモデルを割り当て可能
- 各サブエージェントは独立したコンテキストを持つ
- CLI v2.1.154+ が必要

**ユースケース:** 検証エージェントと実装エージェントを分離し、検証が完了したタスクだけを統合するパイプライン制御。

```javascript
// 動的ワークフロー例: 実装→検証のパイプライン
const plan = await agent(`仕様をタスク分解: ${spec}`, { label: 'planner' });
const tasks = JSON.parse(plan.text);

// 並列実装
const results = await parallel(
  tasks.map(task => () =>
    agent(`実装: ${task.description}`, { label: `impl:${task.id}` })
  )
);

// 逐次検証（前段階の結果を利用）
for (const result of results) {
  const verdict = await agent(
    `検証: ${result.text}\n仕様: ${spec}`,
    { label: `verify:${result.id}` }
  );
  if (!verdict.passed) {
    // 回復: 失敗箇所を再生成
    const fixed = await agent(
      `修正: ${result.text}\nエラー: ${verdict.error}`,
      { label: `fix:${result.id}` }
    );
  }
}
```

### LangGraph — 永続ワークフローと回復

LangGraphはStateGraphによるグラフベースのワークフローを提供。チェックポイント機構により、障害からの復旧が可能。

**キー機能:**
- チェックポインタ（checkpointer）: 各super-stepの状態を保存
- 3つの永続化モード: `exit`（最速）, `async`（バランス）, `sync`（最高耐久）
- thread_id ベースの継続: `graph.invoke(None, config)` で最後のチェックポイントから再開
- 部分復旧: 成功済みノードは再実行せず、失敗ノードのみ再試行

**オージャスト適用例:**
```python
# ブースコード生成の段階的パイプライン
graph = StateGraph(AgentState)

graph.add_node("spec_analysis", spec_analyzer)
graph.add_node("code_generation", code_generator)
graph.add_node("code_validation", code_validator)  # Promptfoo連携
graph.add_node("recovery", recovery_node)

graph.add_edge("spec_analysis", "code_generation")
graph.add_conditional_edges(
    "code_validation",
    decide_next,  # pass → 次フェーズ, fail → recovery
    {"pass": END, "fail": "recovery"}
)

app = graph.compile(checkpointer=MemorySaver())
```

### Promptfoo — 評価と品質ゲート

PromptfooはCLI駆動の評価フレームワークで、アサーションとCI/CD品質ゲートを提供。Claude Agent SDKのネイティブプロバイダとしても機能。

**キー機能:**
- アサーション種別: `contains-json`, `javascript`, `similar`, `cost`, `trace-span-count` 等
- CI/CD統合: GitHub Actions, JUnit XML出力, `--fail-on-error` 品質ゲート
- MCPサーバ: 14のツール（validate, run, generate_test_cases等）をAIエージェントに公開
- 複数プロバイダ比較: 同一テストケースでClaude SDK / OpenCode SDK等を横断比較

**設定例（promptfooconfig.yaml）:**
```yaml
prompts:
  - "次の要件を満たすReactコンポーネントを実装してください: {{requirement}}"
providers:
  - id: anthropic:claude-agent-sdk
    config:
      permission_mode: acceptEdits
      max_concurrency: 1
      max_turns: 30
tests:
  - vars:
      requirement: "フォーム入力検証コンポーネント"
    assert:
      - type: javascript
        value: "output.includes('function validate') || output.includes('const validate')"
      - type: cost
        threshold: 0.05
      - type: trace-span-count
        max: 50
```

### OpenAI Evals — 共有ベンチマーク

OpenAI Evalsは共通ベンチマークレジストリとカスタムEval登録機能を提供。既存の評価ケースを再利用しやすい。

**キー機能:**
- YAML/JSONで評価ケース定義
- カスタムEvalのPythonクラス実装
- コミュニティ共有のEvalレジストリ
- CI/CDパイプラインへの組込み可能

**オージャストでの使い方:**
- ブースコード生成の品質ベンチマークをEvalとして登録
- モデル更新時のリグレッションテストに活用
- コミュニティEvalをベースにカスタマイズ

### Langfuse — トレースとコスト監視

Langfuseはプロダクション向けのトレーシング・プロンプト管理・実験管理・オンライン評価を提供。

**キー機能:**
- 自動トレーシング: LangGraph CallbackHandlerで完全なトレース
- エージェントグラフ可視化: 集約モード（繰り返しをカウント）と展開モード（DAG表示）
- スコアリング: ユーザーフィードバックのトレースへの紐付け
- コスト集計: ���デル別・セッション別のトークン消費と費用

**オージャストでの統合:**
```python
from langfuse.callback import CallbackHandler
langfuse_handler = CallbackHandler()

# LangGraphに渡すだけで自動トレース
config = {"callbacks": [langfuse_handler]}
result = app.invoke(inputs, config)
```

### Arize Phoenix + OpenEvals — エージェントパス評価

Arize PhoenixはOpenTelemetryベースのトレーシングで、エージェントの行動パス（ツール選択・パラメータ抽出・バックトラック等）を評価可能。

**キー機能:**
- エージェントパス評価: パス収束、バックトラック、ツール使用の完全セッション評価
- カスタムルーブリック: LLM-as-a-judge with カテゴリラベル（correct/incorrect）
- セルフホスト: 単一コンテナ + SQLite で運用可能
- OpenEvalsライブラリ: 独立した評価器としてPhoenixなしでも使用可能

**カスタムルーブリック例:**
```python
import phoenix as px
from phoenix.evals import llm_classify

RUBRIC = """
あなたはコード品質評価者です。
以下の基準で出力を評価してください：
- correct: 仕様をすべて満たし、エラーハンドリングが適切
- incorrect: 仕様を満たしていない、またはエラーが発生する可能性がある
- unclear: 判断できない
"""

results = llm_classify(
    dataframe=df,
    template=RUBRIC,
    model="gpt-4o",
)
```

## オージャスト適用計画

### Phase 0: 検証パイプラインの基礎構築（1週間）

| ステップ | 内容 | ツール | コスト見積 |
|----------|------|--------|------------|
| 0.1 | Promptfooの導入と設定 | Promptfoo | 無料（OSS） |
| 0.2 | コード生成タスクの評価テンプレート作成 | Promptfoo + Claude SDK | $0.5〜1 |
| 0.3 | Langfuseのセルフホストデプロイ | Docker + SQLite | サーバー費用のみ |
| 0.4 | 最初の評価実行: 既存コードの品質測定 | Promptfoo | 無料 |

### Phase 1: 自動検証フロー（2週間）

| ステップ | 内容 | ツール | コスト見積 |
|----------|------|--------|------------|
| 1.1 | Claude Agent SDK 動的ワークフローで実装→検証パイプライン | Claude Agent SDK | API費用 |
| 1.2 | LangGraphチェックポイントによる障害復旧機構 | LangGraph + MemorySaver | 無料 |
| 1.3 | 品質ゲート導入: 合格率 < 95% でブロック | Promptfoo CI/CD | 無料 |
| 1.4 | 失敗タスクの自動リカバリ（上限3回） | Claude Agent SDK | API費用 |

### Phase 2: 監視と改善サイクル（3週間）

| ステップ | 内容 | ツール | コスト見積 |
|----------|------|--------|------------|
| 2.1 | Langfuse/Arize Phoenix で全トレース収集 | Langfuse / Phoenix | 無料〜$99/月 |
| 2.2 | エージェントパス分析による品質ボトルネック特定 | Phoenix OpenEvals | 無料 |
| 2.3 | コストダッシュボード構築（モデル別・タスク別） | Langfuse | 無料 |
| 2.4 | 週次評価レポート自動生成 | Promptfoo + CI | 無料 |

### Phase 3: 本番統合（4週間）

| ステップ | 内容 | ツール | コスト見積 |
|----------|------|--------|------------|
| 3.1 | プルリクエスト自動品質ゲート | Promptfoo GitHub Actions | 無料 |
| 3.2 | 実結果追跡ダッシュボード | Langfuse + Phoenix | 無料〜$99/月 |
| 3.3 | モデルルーティング（タスク特性に応じた最適モデル選択） | 全ツール統合 | API費用削減 |

## 期待効果

| 指標 | 現状（推定） | 目標 | 測定方法 |
|------|-------------|------|----------|
| AI生成コードの初回合格率 | 40〜60% | 85%以上 | Promptfoo評価 |
| バグの本番到達率 | 推定10〜20% | 3%未満 | 品質ゲート + トレース |
| コードレビュー工数 | 100%（手動） | 50%削減 | 自動検証 + AIレビュー |
| モデルコスト | — | 30〜50%削減 | Langfuseコスト分析 |
| リカバリ時間 | 手動（時間単位） | 自動（分単位） | チェックポイント復旧時間 |

## 導入コスト

| 項目 | 費用 | 備考 |
|------|------|------|
| ツールライセンス | 無料〜$99/月 | 全ツールOSSまたは無料枠あり |
| ホスティング（Langfuse/Phoenix） | サーバー費用のみ | セルフホスト可能 |
| API費用（評価実行） | $5〜50/月 | タスク数による |
| 導入工数 | 40〜80時間 | Phase 0-3 合計 |

## 参考リソース

- [Promptfoo Claude Agent SDK プロバイダ](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/)
- [Promptfoo CI/CD Integration](https://www.promptfoo.dev/docs/integrations/ci-cd/)
- [Arize Phoenix 評価ガイド](https://arize.com/docs/phoenix/evaluation/llm-evals)
- [Langfuse LangGraph 統合](https://langfuse.com/integrations/frameworks/langgraph)
- [LangGraph チェックポイント](https://langchain-ai.github.io/langgraph/concepts/persistence/)
- [Claude Agent SDK 動的ワークフロー](https://github.com/anthropics/claude-cookbooks/blob/main/claude_agent_sdk/08_Dynamic_workflows.ipynb)
- [OpenAI Evals](https://github.com/openai/evals)
