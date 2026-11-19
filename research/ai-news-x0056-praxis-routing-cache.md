# AIニュース提案 [X-0056]: プロンプトキャッシュとルーティングでトークン支出40-70%削減

**Praxis（Red Hat EnMaaS）** でルーティンcoding/evaluationトラフィックを外部APIから自己ホストオープンウェイトへルーティング。30日で1兆トークン超処理、利用が商業フロンティア70/30からオープン30/70へシフト。プロンプトキャッシュとルーティングによりトークン支出を従来フロンティア比40-70%削減。

観測日: 2026-11-19
出典: Red Hat 公式ブログ (2026-11-09) / Praxis GitHub / CNCF Sandbox Proposal #506

---

## 1. 外部事例: Red Hat EnMaaS（Praxis + llm-d）

### 1.1 全体像

Red Hat（IBM子会社）は2026年11月、内部MaaS（Model-as-a-Service）パイロット「**EnMaaS**（Engineering Model-as-a-Service）」の成果を公開。2つのCNCFサンドボックスプロジェクトを組み合わせた構成:

| コンポーネント | 役割 | 言語 | CNCF寄贈時期 |
|--------------|------|------|------------|
| **Praxis** | AIゲートウェイ（ルーティング・ポリシー・プロトコル変換） | Rust | 2026年9月 |
| **llm-d** | K8sネイティブ分散推論フレームワーク（vLLM + KVキャッシュ階層化） | Go/Rust | 2026年3月 |
| vLLM | ランタイムスケジューリング・複数ポッド連携・KVキャッシュ管理 | Python | — |

### 1.2 実績

| 指標 | 値 |
|------|------|
| 処理トークン数 | **1兆トークン超**（単一30日ウィンドウ） |
| 利用技術者数 | 数千人のRed Hatエンジニア |
| 利用比率変化 | フロンティア70% / オープン30% → **フロンティア30% / オープン70%** |
| トークン支出削減 | **従来フロンティア比 40〜70%** |

### 1.3 アーキテクチャ

```
開発者
  └→ Praxis（AIゲートウェイ・Rust）
      ├→ Body-based routing（リクエスト本文ベースのルーティング）
      ├→ API翻訳（OpenAI ↔ Anthropic ↔ Chat Completions）
      ├→ ガードレール（コンテンツフィルタ・レート制限）
      ├→ トークン会計（ユーザー別・チーム別・モデル別）
      └→ ext_proc ↔ llm-d（分散推論）
           ├→ vLLM + プリフィル/デコード分離
           ├→ KVキャッシュ階層化（GPU/CPU/NVMe）
           └→ Endpoint Picker（EPP）: 推論対応ルーティング
```

---

## 2. 実装したツール `tools/praxis-gateway.mjs`

### 2.1 機能一覧

| 関数 | 対応するPraxis機能 | 説明 |
|------|---------------------|------|
| `staticPrefixMatch` | KV-cache tiering (prefix) | 静的プレフィックス（会社概要・過去事例等）を検出し、キャッシュ可能部分を特定 |
| `bodyRoute` | Body-based routing | プロンプト本文の内容に基づき frontier/medium/economy/batch へルーティング |
| `classifyBodyRoute` | Routing policy | キーワード分析による本文分類（design→frontier, classify→economy） |
| `translateRequest` | Provider translation | OpenAI ↔ Anthropic ↔ Chat Completions 間のプロトコル変換 |
| `tokenAccounting` | Token accounting | モデル別・ルート別・タスク別のトークン消費とコスト集計 |
| `estimateCostReduction` | Cost simulation | 静的プレフィックスキャッシュ＋ルーティング適用時のコスト削減見積もり |

### 2.2 ルーティングテーブル

| ルート | 想定モデル | 入力$/M | 出力$/M |
|--------|-----------|---------|---------|
| frontier | GPT-6 Luna | $10.00 | $40.00 |
| medium | Kimi K3 | $2.50 | $10.00 |
| economy | DeepSeek Flash | $0.15 | $0.60 |
| batch | Batch GPT-4o | $0.08 | $0.30 |

### 2.3 静的プレフィックス一覧（デフォルト）

| プレフィックス名 | パターン文字列 | ルート | TTL |
|----------------|-------------|-------|-----|
| company_profile | 会社概要 | economy | 300s |
| past_case | 過去事例 | economy | 300s |
| event_template | イベント進行台本 | medium | 600s |
| spec_template | 仕様テンプレート | medium | 600s |
| safety_standard | 安全基準 | economy | 900s |
| construction_plan | 施工計画書 | medium | 900s |

---

## 3. 株式会社オージャストへの適用

### 3.1 改善シナリオ

```
改善前（すべて frontier）:
  会社概要(500t) + 過去事例(800t) + 制約条件(300t) + 企画指示(200t) = 1,800t/案
  月間: $0.110/案件

改善後（キャッシュ + body-based routing）:
  Step1: 静的プレフィックス検出 → economyルートへ（prefix 1,600t キャッシュ）
  Step2: 企画方針判断（medium）: 残り200t
  → 月間: $0.019/案件（−83%）
```

### 3.2 コスト削減見積もり

| シナリオ | 案件あたり | 月間1000件 | 削減率 |
|---------|-----------|----------|-------|
| 現状（全frontier） | $0.110 | $110.00 | — |
| 改善A（prefix cache + routing） | $0.019 | $19.00 | **−83%** |
| 改善B（+batch非同期） | $0.005 | $5.00 | **−95%** |

### 3.3 実測計画

過去案件でのトークン支出を以下の手順で計測:

1. 現状のAPI使用量の棚卸し（ChatGPT/Grok/Claude APIの利用履歴から集計）
2. 代表的なプロンプトのトークン数測定（tiktoken/claude-tokenizerで実測）
3. praxis-gateway.mjs で静的プレフィックスキャッシュ＋ルーティングのコストシミュレーション
4. tokenAccounting で削減効果を日次・月次で可視化

---

## 4. 関連提案との関係

| X提案 | 関係 | 差分 |
|-------|------|------|
| X-0057: セマンティックキャッシュ+ルーティング | 補完 | 埋め込みベース vs 静的プレフィックス＋本文ルーティング |
| X-0035: プロンプトキャッシング | 上位概念 | Praxisはゲートウェイ全体、X-0035は個別API機能 |
| X-0084: Praxis詳細リサーチ | リサーチ | X-0084は事例調査、X-0056は実装 |

---

## 5. 出典

- Red Hat EnMaaS ブログ (2026-11-09): Red Hat Engineering Model-as-a-Service with Praxis and llm-d
- Praxis AI Gateway: [github.com/praxis-proxy/ai](https://github.com/praxis-proxy/ai)
- llm-d (K8s-native LLM inference): CNCF Sandbox (2026-03)
- CNCF Sandbox Proposal #506: Praxis submission