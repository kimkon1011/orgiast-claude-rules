# AIニュース提案 [X-0028]: 低コストサンドボックスでAIバイブコーディング

観測日: 2026-11-19
出典: Agent37 / Vercel / E2B / Daytona / Cloudflare Sandbox / Railway
ライセンス: 各サービスの利用規約に準拠

## 概要

2026年11月、Yコンビネーター出資のスタートアップAgent37が公開した「100のコーディングエージェントにサンドボックスを与えバイブコーディングさせたコスト比較」が業界の注目を集めた。AIエージェントがLLM応答を待つ間（約95%）のアイドルCPUを共有することで、Agent37は**1時間あたり$0.68**で100エージェントを同時稼働できる。これはVercel Sandbox（$9.75）の1/14、E2B・Daytona（$16.56）の1/24にあたる。

本提案は、株式会社オージャストの展示会ブース・イベント用ウェブサイトのAIコーディングに、Agent37の標準gVisorサンドボックスを適用し、同様の低負荷条件で$0.68/hのコストを再現するワークフローを提示する。

## 背景: Vercel CEOとの論争と検証

### 発端

Agent37創業者Vishnu Krishnaprasadが「サンドボックスコストで競合比25倍安い」と主張したところ、Vercel CEOのGuillermo Rauchが「アクティブCPU時間を考慮していない」とX（旧Twitter）で指摘。これに対しAgent37側が実際に100エージェントを動かして再計測した結果が上記の数字である。

### 独立した第三者検証

| 検証者 | 結果 |
|--------|------|
| Lenny Enderle | 自身のコーディングエージェント実測: 92% idle / 8.4% active CPU → Agent37 $0.68/h vs Vercel $10.63/h |
| Mac (@MacdevM) | Hermesエージェントで実際のSEO監査ジョブを実行 → 料金計算が一致することを確認 |
| Darius Pop | 約20分の実稼働テスト: Agent37 $0.0023 vs Vercel $0.0325 vs E2B $0.0552 |

### コスト差の理由

AIコーディングエージェントの実態:
- **〜95%がアイドル時間**: LLM（Claude/GPT/Grok）の応答を待っている
- **〜5%がアクティブCPU**: コード編集・git操作・ビルド・テスト実行
- 共有CPU（gVisor）で十分: アイドル時間が大半なら専有CPUは無駄

競合はアクティブCPU時間で課金（Vercel）または秒単位固定（E2B/Daytona）のため、アイドル時間もコストとして計上される。Agent37は分単位従量＋自動スリープで、実CPU使用量に近い課金を実現している。

## Agent37の技術概要

### サンドボックスタイプ

| タイプ | 隔離方式 | 用途 | コンピュート倍率 |
|--------|---------|------|-----------------|
| Default (標準) | gVisor | 軽量タスク・チャット・小スクリプト・待ち時間長いワークロード | 1x |
| VM | KVM | ブラウザ自動化・Docker・Kubernetes・DB | 2.5x |
| Performance | 専有CPU | ビルド・コンパイル・継続的高負荷 | 4x |

### 料金体系（分単位従量）

| リソース | 月額換算（730時間） | 分単位 |
|---------|-------------------|--------|
| vCPU | $0.80/vCPU | $0.0000183/vCPU-min |
| RAM | $0.70/GB | $0.0000160/GB-min |
| Disk | $0.09/GB | $0.0000021/GB-min |

### 標準構成のコスト例

| 構成 | 常時稼働（月） | 100時間稼働 |
|------|--------------|------------|
| 2 vCPU / 4 GB RAM / 4 GB Disk | $4.76 | $0.96 |
| 4 vCPU / 8 GB RAM / 6 GB Disk | $9.34 | $1.87 |
| 4 vCPU / 16 GB RAM / 12 GB Disk | $15.48 | $3.10 |

## 競合比較（100時間稼働・2 vCPU / 4 GB）

| プロバイダ | コスト | 備考 |
|-----------|--------|------|
| **Agent37（標準）** | **$0.96** | 分単位・自動スリープ対応 |
| Agent37（VM） | $1.87 | Docker対応 |
| Northflank | $6.67 | |
| E2B | $16.56 | セッション上限1〜24h |
| Daytona | $16.56 | |
| Cloudflare Sandbox | $18.10 | |
| Vercel Sandbox | $34.08 | アクティブCPU課金含む |
| Railway | $41.67 | |

### ビルドパフォーマンス比較（4 vCPU / 8 GB）

| プロバイダ | Runs/s per $1/h | 1,000 buildsコスト |
|-----------|----------------|-------------------|
| **Agent37** | **1,454** | **$0.99** |
| Blaxel | 102 | $9.81 |
| E2B | 33.45 | $13.96 |
| Vercel | — | $27.64 |
| Modal | — | $27.99 |
| Cloudflare Sandbox | — | $37.98 |

## オージャスト適用ワークフロー

展示会ブース・イベント用ウェブサイトのAIコーディングにおいて、以下の3フェーズでAgent37サンドボックスを活用する。

### フェーズ1: 環境セットアップ（初期）

```bash
# 1. Agent37アカウント作成 + $5クレジットチャージ
# 2. サンドボックステンプレート選択（標準gVisor、2 vCPU / 4 GB）
# 3. Codexテンプレートのデプロイ（agent37-codex テンプレート使用）
agent37 sandbox create --template agent37-codex --name orgiast-event-site
```

**コスト**: セットアップ1回あたり約$0.01（5分程度）

### フェーズ2: イベントサイトのAIコーディング（実作業）

```yaml
# 1サンドボックスあたりの想定リソース
# テンプレート: agent37-codex（OpenAI Codex + 自分のAPIキー）
# vCPU: 2 (共有・gVisor)
# RAM: 4 GB
# Disk: 4 GB
# 自動スリープ: 5分無操作で有効
```

**ワークフロー**:
1. プロンプトファイルをサンドボックスにアップロード
2. CodexエージェントがHTML/CSS/JSを生成
3. 生成結果をlocalhostでプレビュー確認
4. 修正があれば追加プロンプトで反復
5. 完成したコードをgit push

**推定コスト（1サイトあたり）**:
- 実作業時間: 約2時間（うちアクティブCPU: 約6分 = 5%）
- Agent37コスト: 約$0.014（2時間のアイドル含むディスク代）
- Codex APIコスト: 別途（各自の契約による）

### フェーズ3: 並列エージェント展開（展示会直前の集中作業）

複数のイベントサイトを同時コーディングする場合:

```yaml
同時稼働サンドボックス: 5〜10（展示会シーズン中のみ）
各サンドボックス: 2 vCPU / 4 GB / 標準gVisor
想定アクティブ率: 5%
```

**推定コスト**:
- 10サンドボックス × 8時間/日 × 5日間 = 400サンドボックス時間
- Agent37: **約$4.80**（Vercelなら約$390）
- Codex APIコスト: 別途（各自の契約による）

## 制限と注意点

| 項目 | 内容 |
|------|------|
| GPU非対応 | 画像生成・動画処理には別途GPU環境が必要 |
| Docker不可（標準） | Dockerが必要なワークロードはVMタイプ（2.5x）を選択 |
| 自動スリープはオプトイン | 明示設定しないとアイドルでも課金継続 |
| $5クレジットのみ | 無料トライアルは競合より少なめ（E2Bは$10、Daytonaは$20） |
| ネットワーク遅延 | 東京リージョンの有無は要確認（USリージョンが基本） |

## 期待される効果

| 指標 | 現状 | Agent37導入後 | 備考 |
|------|------|--------------|------|
| サイト1件あたりのAIコーディング費用 | 計測中 | $0.01〜0.05（サンドボックス代のみ） | APIコストは別 |
| 並列作業可能なエージェント数 | 1（人手） | 5〜10（同時） | 展示会シーズン対応 |
| サイト作成から公開までの時間 | 数日〜1週間 | 数時間 | 人間のレビュー時間は別 |
| 月間サンドボックス費用 | — | $5〜20（常時5〜10台） | APIコスト含まず |

## 再現方法

```bash
# 1. Agent37にサインアップ（$5クレジット取得）
# 2. コード生成テンプレートをデプロイ
agent37 sandbox create --template agent37-codex --name vibecoding-test

# 3. SSH/APIでサンドボックスに接続
agent37 sandbox connect --name vibecoding-test

# 4. プロンプトファイルを配置してCodexを実行
codex-do.mjs "展示会用ランディングページを作成（Next.js + Tailwind）" \
  --cwd /workspace \
  --timeout 600

# 5. 生成結果を確認
ls /workspace/out/
```

## 出典

- [Agent37 Pricing](https://www.agent37.com/pricing) — 分単位従量の料金詳細
- [Agent37 YC Launch](https://www.ycombinator.com/launches/XNf-agent37-the-cheapest-ai-sandbox) — Yコンビネーター発表
- [Vishnu Krishnaprasad (@an_engineer_log) on X](https://x.com/an_engineer_log) — 100エージェントコスト比較の元ポスト
- [Agent37 Blog: Run AI Agents in Parallel](https://www.agent37.com/blog/run-ai-agents-in-parallel-setup-guide) — 並列エージェント実行ガイド
- [Agent37 Blog: Coding Agent Benchmark Guide](https://www.agent37.com/blog/coding-agent-benchmark-guide) — ビルドパフォーマンス比較
- [Today for AI](https://todayforai.com/) — 第三者検証の引用元