# X-0036: OSSでAIコーディングエージェント信頼性システム構築

**AIニュース提案 X-0036**: ツール — Claude Code、Claude Agent SDK、LangGraph、OpenAI Evals、Promptfoo、Langfuse、Arize Phoenix、OpenEvals。エージェントが結果を証明するシステムを構築。株式会社オージャストではブース制作サイトのコーディングやUI生成にこれら評価・トレースツールを使い出力検証を自動化し再現ワークフローにする。

観測日: 2026-11-13

---

## 1. 概要

AIコーディングエージェントの最大の課題は **「出力が正しいことを誰がどう証明するか」** にある。人間が全行をレビューしていては自動化の意味が半減する。本提案は、OSSの評価・トレースツールを組み合わせて「エージェントが自分の出力を自動検証し、トレース可能な形で証跡を残す」信頼性システムを構築する。

**アーキテクチャの全体像:**

```
[Agent Layer]
Claude Code / Claude Agent SDK / LangGraph
    ↓ 出力
[Evaluation Layer]
OpenAI Evals / Promptfoo / OpenEvals
    ↓ スコア・pass/fail
[Observability Layer]
Langfuse / Arize Phoenix
    ↓ トレース・メタデータ保存
[Evidence Store]
JSONL / ファイル / スプレッドシート
```

| レイヤー | ツール | 役割 |
|---------|--------|------|
| エージェント実行 | Claude Code, Claude Agent SDK, LangGraph | コード生成・UI生成・タスク実行 |
| 評価・検証 | OpenAI Evals, Promptfoo, OpenEvals | 生成結果の正しさを自動判定 |
| 可観測性・トレース | Langfuse, Arize Phoenix | 実行履歴・コスト・レイテンシの記録 |
| 証跡保存 | JSONL / ファイル / Google Sheets | 再現可能なワークフローの永続化 |

---

## 2. 各ツールの役割と連携

### 2.1 エージェント実行層

#### Claude Code + Claude Agent SDK

Anthropic の2つのプロダクトをエージェント基盤として使う。

| 項目 | Claude Code | Claude Agent SDK |
|------|------------|-----------------|
| 形態 | CLIツール（ターミナルエージェント） | SDK（プログラムからの呼び出し） |
| 適性 | ファイル編集・git操作・シェル実行 | API呼び出し・バックエンド統合 |
| 評価連携 | 出力ファイルを評価ツールで検証 | 戻り値を直接 OpenEvals へ渡す |
| トレース連携 | 実行ログを Langfuse へ送信 | SDK内でトレースコンテキストを伝播 |

**連携パターン:**

```
Claude Code → ファイル出力 → eval-harness.mjs（正しさ検証）→ Langfuse（トレース保存）
Claude Agent SDK → 戻り値 → OpenEvals（即時評価）→ Arize Phoenix（可観測性）
```

#### LangGraph

LangChain が提供するグラフベースのエージェントオーケストレーション。複数のエージェント・ツール呼び出しを有向グラフとして定義し、各ノードの実行・評価・条件分岐を明示的に制御する。

| 機能 | 説明 | 信頼性への貢献 |
|------|------|--------------|
| ステートグラフ | ノード間の状態遷移をグラフで定義 | エージェントの実行パスが予測可能・検証可能 |
| 条件付きエッジ | 前ノードの結果に応じて分岐 | エラーハンドリングの明示化 |
| ヒューマンインザループ | 特定ノードで人間の承認を待つ | クリティカルな判断の自動化防止 |
| チェックポインター | 各ノードの状態を永続化 | 途中からの再開・デバッグが容易 |
| 並列実行 | 独立ノードを並行実行 | 評価ノードを生成ノードと並列化 |

**LangGraph × 評価の連携:**

```
[CodeGen Node] → [Eval Node (OpenAI Evals)]
    ↓ fail時         ↓ pass時
[Retry Node]     [Trace Node (Langfuse)]
    ↓ 3回失敗        ↓
[HumanFallback]  [Evidence Save]
```

---

### 2.2 評価・検証層

#### OpenAI Evals

OpenAI が公開する評価フレームワーク（Python, OSS）。LLM の出力をテストケースに対して評価する。

| 機能 | 説明 | 利用シーン |
|------|------|-----------|
| モデル graded eval | LLM に採点させる評価 | UI生成結果の視覚的品質評価 |
| 実行時チェック | 出力が特定条件を満たすか判定 | コードの構文チェック・型チェック |
| カスタム評価関数 | Python で任意の評価ロジック | ビジネスルールの検証 |
| バッチ評価 | 複数テストケースを一括実行 | リグレッションテスト |

**既存の `eval-harness.mjs` との関係:**

本リポジトリの `tools/eval-harness.mjs` は OpenAI Evals の考え方を踏襲し、Node.js 上で provider 横断の成功率・コスト計測を実現している。X-0036 ではこれを拡張し、OpenAI Evals の graded eval パターンや Promptfoo の regression testing と統合する。

#### Promptfoo

プロンプトのテスト・レッドチーミング・評価を CLI で実行する OSS フレームワーク。

| 機能 | 説明 | オージャストでの活用 |
|------|------|-------------------|
| テストケース定義 | YAML/JSON で入力・期待出力を記述 | ブース企画プロンプトの網羅的テスト |
| レッドチーミング | 攻撃的プロンプトで脆弱性を検出 | 顧客情報漏洩リスクの事前検出 |
| 回帰テスト | プロンプト変更前後の出力比較 | 企画プロンプト改善時の品質維持 |
| テーブル比較 | 複数モデル・パラメータの横断比較 | Claude / GPT / Gemini の出力品質比較 |
| CI統合 | GitHub Actions での自動実行 | PR 時にプロンプト変更の影響を自動確認 |

**設定例（promptfooconfig.yaml）:**

```yaml
prompts:
  - "展示会ブース企画を考えてください。\n企業概要: {{company}}\n予算: {{budget}}\n会場: {{venue}}"
providers:
  - anthropic:claude-sonnet-5-5
  - openai:gpt-6
tests:
  - vars:
      company: "精密機械メーカーA社"
      budget: "200万円"
      venue: "東京ビッグサイト"
    assert:
      - type: contains
        value: "3m×3m"
      - type: llm-rubric
        value: "予算内で実現可能な具体的プランが提案されている"
  - vars:
      company: "食品メーカーB社"
      budget: "500万円"
      venue: "インテックス大阪"
    assert:
      - type: contains-any
        value: ["試食", "サンプリング", "調理実演"]
```

#### OpenEvals

LangChain が公開する軽量評価ライブラリ（Python/JS）。実行時評価に特化。

| 評価関数 | 用途 | 例 |
|---------|------|-----|
| `embedding_similarity` | 意味的類似度の測定 | 生成UIが要求と合致しているか |
| `contains` | 文字列包含チェック | キーワードの必須含有 |
| `regex_match` | パターンマッチ | 電話番号・メール形式の検証 |
| `exact_match` | 完全一致 | 決まったフォーマットの出力検証 |
| `llm_grader` | LLMによる採点 | ブース企画の品質評価 |

---

### 2.3 可観測性・トレース層

#### Langfuse

LLM アプリケーション向けのオープンソース可観測性プラットフォーム（セルフホスト可能）。

| 機能 | 説明 | オージャストでの活用 |
|------|------|-------------------|
| トレース | 1リクエストの全工程を追跡 | 企画生成〜評価までの一貫トレース |
| スパン | 各工程の詳細（時間・トークン・モデル） | プロバイダ別コスト・レイテンシ分析 |
| スコアリング | 人間・LLMによる採点を付与 | 生成結果の品質スコア履歴 |
| プロンプト管理 | プロンプトのバージョン管理・ABテスト | 企画プロンプトの改善サイクル |
| コスト分析 | プロバイダ別・モデル別のコスト集計 | 月次のAI利用料金の透明化 |
| セルフホスト | Docker Compose で自社サーバに配置 | 顧客データを外部に送信しない |

**トレースデータ構造:**

```json
{
  "id": "trace_booth_gen_20261113",
  "name": "booth-proposal-generation",
  "spans": [
    {
      "name": "generate-company-profile",
      "model": "claude-sonnet-5-5",
      "input_tokens": 1500,
      "output_tokens": 800,
      "duration_ms": 4500,
      "cost_usd": 0.012
    },
    {
      "name": "evaluate-output",
      "evaluator": "openai-evals",
      "score": 0.92,
      "threshold": 0.85,
      "passed": true
    },
    {
      "name": "save-evidence",
      "output_file": "proposals/v3/booth_A_proposal.pdf"
    }
  ],
  "total_cost_usd": 0.034,
  "total_duration_ms": 8200
}
```

#### Arize Phoenix

Arize AI が公開する AI 可観測性プラットフォーム（OSS）。エージェントの実行時分析とデバッグに特化。

| 機能 | 説明 | エージェント信頼性への貢献 |
|------|------|------------------------|
| スパントレース | LLM 呼び出しの詳細トレース | エージェントの思考過程の可視化 |
| エンベッディング可視化 | 出力のベクトル分布を UMAP 表示 | 異常出力のクラスタ検出 |
| ドリフト検出 | 経時的な出力品質の変化を監視 | モデル更新・プロンプト変更の影響検知 |
| セッションリプレイ | 過去の実行を再現・デバッグ | エラー再現と修正検証 |
| ガードレール分析 | 入力・出力のフィルタリング効果測定 | 安全対策の実効性確認 |

---

## 3. 統合アーキテクチャ: エージェント信頼性パイプライン

### 3.1 提案する全体構成

```
                    ┌──────────────────────────────────┐
                    │         LangGraph Orchestrator      │
                    │   (StateGraph: ノード間の状態管理)    │
                    └────────────┬─────────────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
  ┌──────────────┐     ┌────────────────┐     ┌──────────────┐
  │ Claude Code  │     │ Claude SDK     │     │  Sub-agents  │
  │ (ファイル操作) │     │ (API呼び出し)   │     │ (分類・検索)  │
  └──────┬───────┘     └───────┬────────┘     └──────┬───────┘
         │                     │                      │
         └─────────────────────┼──────────────────────┘
                               ▼
                  ┌──────────────────────┐
                  │   Evaluation Layer    │
                  │  ┌─────────────────┐  │
                  │  │ OpenAI Evals    │  │  graded eval / exact match
                  │  │ Promptfoo       │  │  regression / red-teaming
                  │  │ OpenEvals       │  │  embedding_similarity / llm_grader
                  │  └─────────────────┘  │
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │   Observability      │
                  │  ┌─────────────────┐  │
                  │  │ Langfuse        │  │  トレース・コスト・スコア
                  │  │ Arize Phoenix   │  │  ドリフト検出・セッションリプレイ
                  │  └─────────────────┘  │
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │   Evidence Store     │
                  │  JSONL / Sheets / FS │  証跡の永続化
                  └──────────────────────┘
```

### 3.2 評価ゲートの種類と配置

| ゲート | ツール | トリガー | 失敗時アクション |
|--------|-------|---------|---------------|
| 構文検証 | OpenEvals `regex_match` | コード生成直後 | 再生成（最大3回） |
| 型チェック | シェル実行（`node --check`） | ファイル保存後 | エラー箇所を特定し修正 |
| 意味的品質 | OpenAI Evals graded eval | 企画書生成後 | 人間レビューにエスカレーション |
| コスト上限 | Langfuse cost analysis | 毎ターン終了時 | 次ターンでモデルを1段階安く |
| 回帰テスト | Promptfoo バッチ実行 | PR作成時 | CI で赤にしマージブロック |

---

## 4. 株式会社オージャストへの適用

### 4.1 現状の課題

| 課題 | 具体例 | 影響 |
|------|--------|------|
| 出力検証が目視依存 | ブースパースの品質確認に毎回人間の目視が必要 | 自動化のボトルネック |
| プロンプト変更の影響不明 | 企画プロンプトを微修正したら品質が低下 | 気づかずに品質劣化したプロンプトで量産 |
| コストの可視性不足 | どのプロバイダ・モデルが費用対効果が高いか不明 | コスト最適化の判断ができない |
| 再現性の欠如 | 同じ条件で生成したはずが結果が異なる | クライアントへの説明責任が果たせない |
| エラー追跡の手間 | 生成失敗時に原因特定に時間がかかる | トラブルシューティングの工数増加 |

### 4.2 フェーズ別導入計画

#### Phase 1（即日〜1週間）: 評価基盤

既存の `eval-harness.mjs` を拡張し、ブース企画生成に特化した評価タスクセットを追加する。

| ステップ | 作業 | 成果物 |
|---------|------|--------|
| 1-1 | ブース企画のゴールデンテスト10ケースを定義 | `tools/eval-tasks.seed.jsonl` に追加 |
| 1-2 | `eval-harness.mjs` で Claude / GPT / Gemini の成功率を計測 | プロバイダ別スコア表 |
| 1-3 | 評価結果を Langfuse（またはJSONL）に記録 | 初回トレースデータ |

**Golden Test 例:**

```jsonl
{"id": "booth-layout-3x3", "category": "booth-design", "prompt": "3m×3mの小間で精密機械メーカーの展示ブース企画を考えてください。壁面活用、商談スペース、製品展示の3要素を含めてください。", "expect": {"type": "contains", "value": "3m×3m"}, "max": 1024}
{"id": "booth-budget-2m", "category": "booth-design", "prompt": "200万円予算で、食品メーカーの試食主体ブース企画を考えてください。", "expect": {"type": "judge"}, "max": 1024}
{"id": "ui-component-button", "category": "ui-gen", "prompt": "Reactで、3つの状態（default/hover/disabled）を持つプライマリボタンコンポーネントを生成してください。Props: label, onClick, disabled", "expect": {"type": "contains", "value": "export"}, "max": 512}
```

#### Phase 2（1〜2週間）: トレース・可観測性

Langfuse（セルフホスト）または Arize Phoenix で生成パイプラインの全工程をトレースする。

| ステップ | 作業 | 成果物 |
|---------|------|--------|
| 2-1 | Langfuse を Docker Compose でセルフホスト | `docker-compose.yml` + 設定 |
| 2-2 | エージェント実行後にトレースデータを送信するラッパー | `tools/trace-send.mjs` |
| 2-3 | 週次のコスト・品質レポートを自動生成 | `tools/weekly-report.mjs` |

**トレース送信ラッパー:**

```mjs
// tools/trace-send.mjs — Langfuse 互換の軽量トレース記録
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TRACE_DIR = path.join(os.homedir(), '.claude', 'traces');

export function traceEvent({ name, model, inTok, outTok, durationMs, costUsd, score, passed }) {
  const dir = path.join(TRACE_DIR, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    t: new Date().toISOString(),
    name, model, inTok, outTok, durationMs, costUsd, score, passed,
  };
  fs.appendFileSync(path.join(dir, 'traces.jsonl'), JSON.stringify(record) + '\n');
  return record;
}

export function readTraces(dateStr) {
  const file = path.join(TRACE_DIR, dateStr, 'traces.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
}

export function weeklyReport() {
  // 直近7日間のトレースを集計
  const traces = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    traces.push(...readTraces(dateStr));
  }
  const total = traces.length;
  const passed = traces.filter(t => t.passed).length;
  const totalCost = traces.reduce((s, t) => s + (t.costUsd || 0), 0);
  return {
    period: '直近7日間',
    totalTraces: total,
    passRate: total ? (passed / total * 100).toFixed(1) + '%' : 'N/A',
    totalCostUsd: totalCost.toFixed(4),
    avgDurationMs: total ? Math.round(traces.reduce((s, t) => s + (t.durationMs || 0), 0) / total) : 0,
  };
}
```

#### Phase 3（2〜4週間）: CI/CD 統合

Promptfoo の回帰テストを GitHub Actions に組み込み、PR 作成時にプロンプト変更の影響を自動確認する。

| ステップ | 作業 | 成果物 |
|---------|------|--------|
| 3-1 | Promptfoo 設定ファイルをリポジトリに追加 | `promptfooconfig.yaml` |
| 3-2 | GitHub Actions ワークフローで promptfoo eval を自動実行 | `.github/workflows/promptfoo-regression.yml` |
| 3-3 | 評価結果を PR コメントとして投稿 | ワークフロー成果物 |

### 4.3 期待効果

| 指標 | 改善前 | 改善後（推定） |
|------|--------|---------------|
| 出力検証の自動化率 | 0%（全目視） | 80%（自動評価） |
| プロンプト変更の回帰検出 | 手動確認のみ | CI で自動検出（変更後5分） |
| コストの可視性 | 月次請求書のみ | 日次・プロバイダ別トレース |
| エラー原因特定時間 | 30分〜数時間 | トレース参照で5分以内 |
| 生成結果の再現性 | 低（記録なし） | 高（全トレース永続化） |

### 4.4 コスト試算

| 項目 | 月間コスト（推定） | 備考 |
|------|------------------|------|
| Langfuse セルフホスト（VPS） | $5〜10 | 1GB RAM の安価な VPS で稼働 |
| Arize Phoenix（OSS、同梱） | $0 | セルフホスト版は無料 |
| Promptfoo（OSS） | $0 | CLI ツール、CI分の実行時間のみ |
| OpenAI Evals（OSS） | $0 | Python ライブラリ、実行は自前 |
| 評価用 API コスト（増分） | $5〜15 | 既存の生成 API に加算する評価分 |
| **合計** | **$10〜25/月** | 導入障壁の低いコスト |

---

## 5. 実装ロードマップ

| Phase | 期間 | 成果物 | 依存 |
|-------|------|--------|------|
| 0: 現状分析 | 1日 | `eval-harness.mjs` のブースタスク追加 | なし |
| 1: 評価基盤 | 1週間 | Golden test suite + プロバイダ比較表 | Phase 0 |
| 2: トレース | 1〜2週間 | Langfuse セルフホスト + `trace-send.mjs` | Phase 1 |
| 3: CI/CD統合 | 2〜4週間 | GitHub Actions + Promptfoo 回帰テスト | Phase 2 |
| 4: 全自動化 | 4〜8週間 | エージェント→評価→トレースの完全パイプライン | Phase 3 |

---

## 6. 既存の関連ツールとの関係

本リポジトリには既に以下の関連ツールが存在する。X-0036 はこれらを評価・トレースのレンズで拡張する。

| 既存ツール | 機能 | X-0036 での拡張 |
|-----------|------|----------------|
| `eval-harness.mjs` | プロバイダ横断の成功率・コスト計測 | ブース企画に特化したゴールデンテスト追加 |
| `eval-harness.test.mjs` | eval-harness の単体テスト | テストケースの拡充 |
| `eval-exec-checks.mjs` | 実行時チェック関数 | OpenEvals パターンの統合 |
| `trace-send.mjs`（本提案） | 軽量トレース記録（新規） | Langfuse / Arize のセルフホスト版への移行パス |

---

## 7. 注意点・リスク

| リスク | 確度 | 対策 |
|--------|------|------|
| 評価自体の品質（誰が評価者を評価するか） | 中 | ゴールデンテストの定期的な人間レビュー |
| セルフホストの運用負荷 | 低 | Docker Compose で最小構成、障害時は JSONL にフォールバック |
| 評価コストの増加 | 低 | 評価は安価モデル（Haiku / Grok Fast）に限定 |
| 偽陽性・偽陰性 | 中 | graded eval は複数モデルで多数決、閾値調整 |
| プライバシー（顧客データのトレース） | 低 | セルフホストで自社環境に閉じる |

---

## 8. 結論

| 項目 | 推奨 | 開始方法 |
|------|------|---------|
| 評価基盤 | **eval-harness.mjs にブースタスク追加** | Golden test 10ケースを seed に追加 |
| トレース基盤 | **trace-send.mjs で JSONL 記録から開始** | `tools/trace-send.mjs` を作成・組み込み |
| CI/CD統合 | **Promptfoo + GitHub Actions** | Phase 3 で対応 |
| Langfuse セルフホスト | **推奨（JSONL が100件超えたタイミング）** | Docker Compose でセットアップ |

OSS ツールを組み合わせることで、**月額 $10〜25 の追加コスト**でエージェントの出力検証を自動化し、全工程をトレース可能にできる。特にオージャストの既存 `eval-harness.mjs` 資産を活用すれば、Phase 1 は即日着手可能である。

---

## 9. 参考文献

- [OpenAI Evals](https://github.com/openai/evals) — OSS 評価フレームワーク
- [Promptfoo](https://www.promptfoo.dev/) — プロンプトテスト・レッドチーミング
- [Langfuse](https://langfuse.com/) — LLM 可観測性プラットフォーム（OSS/Cloud）
- [Arize Phoenix](https://github.com/Arize-AI/phoenix) — AI 可観測性（OSS）
- [OpenEvals](https://github.com/langchain-ai/open-evals) — LangChain 軽量評価ライブラリ
- [LangGraph](https://github.com/langchain-ai/langgraph) — グラフベースエージェントオーケストレーション
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk) — Anthropic エージェント SDK
- X-0012: 検証可能で再現可能なAIワークフロー
- X-0013: 再現可能なAIワークフローの実装
- X-0018: 構築エージェント＋評価エージェントのUI改善ループ
- X-0023: 7つのOSSでAIエージェントワークフローインフラ構築
- X-0029: Ahrefs監査×GSC優先度判定ツール
- `docs/ai-news-x0012-verifiable-reproducible-workflow.md`
- `docs/ai-news-x0013-reproducible-ai-workflows.md`
- `docs/ai-news-x0023-seven-oss-workflow-infrastructure.md`
- `tools/eval-harness.mjs`
- `tools/eval-exec-checks.mjs`
