# X-0005: 詳細設計によるAI記事ライター構築とSEO記事量産システム（ランブック）

観測日: 2026-11-10。出典: AIニュース digest X-0005「詳細設計によるAI記事ライター構築とSEO記事量産」。
本稿は外部システムの設計思想を分析し、「株式会社オージャストで試す手順」＝展示会ブース制作事例・イベントレポート記事を同様の設計・ルール・QCプロセスでAI生成し、自社サイトに掲載してSEO/LLMO効果を測定するための実装設計書である。

## 外部システムの概要

| 項目 | 数値 |
|------|------|
| 事前学習データ | 既存記事6,440本（約1,900万字） |
| 設計資料の規模 | 記事同等〜2倍の分量 |
| 執筆ルール数 | 64項目 |
| QC項目数 | 22項目 |
| 並列実行 | 最大20体の未学習サブエージェント |
| 生産能力 | 200本を約1時間 |
| 人間レビュー修正 | 約3.2か所/本 |
| 改良回数（8ヶ月） | 59回（機能追加33、不具合修正19、その他7） |

### ワークフロー

```
Google広告プランナーKW分析
  → 検索上位分析
  → 検索意図判定
  → 目標文字数・タイトル・H2/H3構成・文字数配分・共起語回数指定
  → 自社事実中央値約60項目をH2に割当
  → FAQ書式・文体見本・禁止語を追加
  → 64項目ルールを付与
  → 未学習サブエージェント（1体2本）に設計書とルールのみ渡し執筆
  → 22項目QCを自己実施
  → 合格のみ納品
```

### 外部システムの特徴

1. **設計資料が記事本体の2倍**: テンプレート的な出力を防ぐため、事前設計に徹底的に時間をかけている。KW分析、競合分析、検索意図、構成案、配分指定が含まれる。
2. **未学習サブエージェント**: 事前学習データ（6,440本）を与えた本体とは別に、**未学習のサブエージェント**（1体につき2本の記事）に設計書とルールだけを渡して執筆させる。これにより過学習やテンプレート化を防止。
3. **22項目QCの自己実施**: 生成したサブエージェント自身が22項目の品質チェックを自己実施し、合格した記事のみ納品。不合格は再生成。
4. **継続的改良**: 8ヶ月で59回の改良（週1.7回）。機能追加だけでなく不具合修正も頻繁に行い、人間レビューの修正箇所を約3.2か所まで低減。

## オージャストで実装するシステム設計

### 対象コンテンツ

フェーズ1では以下の2種類を対象とする：

| カテゴリ | 例 | 年間目標 |
|---------|-----|---------|
| 展示会ブース制作事例 | 2026年日本イベント大賞受賞事例、各展示会のブースレポート | 24本（月2本） |
| イベントレポート記事 | 自社出展レポート、業界トレンド分析 | 12本（月1本） |

### システムアーキテクチャ

```
┌─────────────────────────────┐
│      管理ダッシュボード       │ ← 経理ハブ / または単一HTML
│  (記事計画・進捗・QC結果)    │
└──────────┬──────────────────┘
           │
┌──────────▼──────────────────┐
│    設計書生成エンジン         │ ← Gemini（分類・構造化）
│  KW分析・構成案・配分指定    │
│  FAQ/文体/禁止語の付与        │
└──────────┬──────────────────┘
           │
┌──────────▼──────────────────┐
│    執筆ディスパッチャー       │ ← サブエージェント制御
│  Supabaseキュー + 並列実行   │
└──────────┬──────────────────┘
           │
┌──────────▼──────────────────┐
│    QC検証エンジン            │ ← 22項目自動チェック
│  SEOスコア・事実誤認・文体   │
│  リンク切れ・文字数・冗長性  │
└──────────┬──────────────────┘
           │
┌──────────▼──────────────────┐
│    出力整形 / 公開           │
│  Markdown → HTML             │
│  記事管理DBへの登録           │
└─────────────────────────────┘
```

### データモデル

#### 設計書（article_spec）

```typescript
interface ArticleSpec {
  id: string;
  status: 'draft' | 'ready' | 'writing' | 'qc' | 'passed' | 'failed' | 'published';
  
  // KW分析
  keyword: string;
  keywordAnalysis: {
    volume: number;
    difficulty: number;
    cpc: number;
    searchIntent: 'informational' | 'navigational' | 'commercial' | 'transactional';
    relatedKeywords: string[];
  };
  
  // 上位分析
  topResults: {
    url: string;
    title: string;
    wordCount: number;
    h2Structure: string[];
    coOccurrenceWords: string[];
    gap: string[]; // 自社でしか書けない内容
  }[];
  
  // 構成
  structure: {
    totalChars: number;
    title: string;
    metaDescription: string;
    h2s: H2Section[];
    faq?: FAQItem[];
  };
  
  // ルール
  rules: {
    style: string;       // 文体見本
    prohibitedWords: string[];
    requiredKeywords: string[];
    coOccurrenceTarget: Record<string, number>; // 語句ごとの最低出現回数
  };
  
  // 自社事実
  facts: FactAssignment[];
  
  // 結果
  result?: {
    articleBody: string;
    wordCount: number;
    qcResult: QCResult;
    agentUsed: string;
    generationTime: number;
  };
}
```

#### QC評価（22項目）

```typescript
interface QCItem {
  id: string;
  category: 'seo' | 'fact' | 'style' | 'structure' | 'technical';
  name: string;
  description: string;
  passThreshold: number; // 0-1
}

// QC項目一覧（22項目）
const QC_ITEMS: QCItem[] = [
  // SEO系（6項目）
  { id: 'QC01', category: 'seo', name: 'タイトルKW含有', threshold: 1.0 },
  { id: 'QC02', category: 'seo', name: 'メタ description 存在', threshold: 1.0 },
  { id: 'QC03', category: 'seo', name: 'H2にKW分散', threshold: 0.8 },
  { id: 'QC04', category: 'seo', name: '共起語最低回数充足', threshold: 1.0 },
  { id: 'QC05', category: 'seo', name: '内部リンク適正', threshold: 0.8 },
  { id: 'QC06', category: 'seo', name: '文字数範囲内（目標±20%）', threshold: 1.0 },
  // 事実系（5項目）
  { id: 'QC07', category: 'fact', name: '自社事実の正確反映', threshold: 1.0 },
  { id: 'QC08', category: 'fact', name: 'ハルシネーション不在', threshold: 1.0 },
  { id: 'QC09', category: 'fact', name: '日付・数値の整合', threshold: 1.0 },
  { id: 'QC10', category: 'fact', name: '固有名詞の正誤', threshold: 1.0 },
  { id: 'QC11', category: 'fact', name: '禁止語不使用', threshold: 1.0 },
  // 文体系（5項目）
  { id: 'QC12', category: 'style', name: '文体見本との一致度', threshold: 0.7 },
  { id: 'QC13', category: 'style', name: '冗長表現不在', threshold: 0.8 },
  { id: 'QC14', category: 'style', name: '一文の長さ適正（80字以内）', threshold: 0.8 },
  { id: 'QC15', category: 'style', name: '段落適正長さ', threshold: 0.7 },
  { id: 'QC16', category: 'style', name: '箇条書きの適正使用', threshold: 0.7 },
  // 構造系（3項目）
  { id: 'QC17', category: 'structure', name: 'H2/H3構成が設計と一致', threshold: 0.9 },
  { id: 'QC18', category: 'structure', name: 'FAQ構造化データ対応', threshold: 0.8 },
  { id: 'QC19', category: 'structure', name: 'セクション間の文字数バランス', threshold: 0.7 },
  // 技術系（3項目）
  { id: 'QC20', category: 'technical', name: 'リンク切れなし', threshold: 1.0 },
  { id: 'QC21', category: 'technical', name: 'Markdown構文正', threshold: 1.0 },
  { id: 'QC22', category: 'technical', name: '出力が指定フォーマット一致', threshold: 1.0 },
];
```

### 執筆ルール（64項目から主要ルールを抽出）

| # | カテゴリ | ルール | 強制力 |
|---|---------|--------|-------|
| 1 | タイトル | 30〜50字、KWを前方に配置 | MUST |
| 2 | タイトル | 数字を含める（年号・数量等） | MUST |
| 3 | 冒頭 | 課題提示→解決策の提示 3段落以内 | MUST |
| 4 | H2 | 1セクション200〜400字 | SHOULD |
| 5 | H2 | 必ず具体的事実を1つ以上 | MUST |
| 6 | 事実 | 年・月・会社名・数値は設計書参照 | MUST |
| 7 | 共起語 | 設計書指定の共起語を各セクションに分散 | MUST |
| 8 | 文体 | 「ですます調」で統一 | MUST |
| 9 | 文体 | 一文60字以内が目安、80字絶対上限 | MUST |
| 10 | 禁止 | 煽り表現（「驚愕」「必見」「今すぐ」等）不使用 | MUST |
| 11 | 禁止 | 不確かな比較（「業界No.1」「最大」等）不使用 | MUST |
| 12 | FAQ | 3〜5問、構造化データ対応 | SHOULD |
| 13 | 内部リンク | 関連記事へのリンクを1〜2箇所 | SHOULD |
| 14 | 画像 | 「画像を入れる」プレースホルダを出力 | SHOULD |
| 15 | 重複 | 既存記事との重複10%未満 | MUST |

### 実装ロードマップ

#### Phase 1: 設計書テンプレートと単体記事生成（1〜2週間）

1. 記事設計書のJSON Schema作成
2. 展示会ブース事例テンプレート（H2固定構成）の作成
3. 単一エージェントによる記事生成パイプライン（codex-do委譲）
4. QC22項目チェッカー（LLM判定によるスコアリング）
5. テスト: 既存の実事例（例: イベント大賞受賞）で1本生成・QC通過確認

#### Phase 2: キュー管理と並列化（2〜3週間）

6. Supabaseキュー（article_queue）の設計
7. ディスパッチャー（最大20並列制御、レート制限、タイムアウト）
8. 生成結果のQC自動判定と再試行ロジック
9. 管理画面（経理ハブに追加 / または単一HTML）
10. テスト: 3本同時生成・QC合格率・処理時間計測

#### Phase 3: 設計書自動生成とSEO連携（3〜4週間）

11. Google広告プランナーまたはKW調査APIの連携
12. 競合記事分析（検索上位10位のH2構造抽出）
13. 検索意図判定モデル（Gemini分類）
14. 設計書の自動生成パイプライン
15. 記事公開後のSearch Console/GA4連携（効果測定）

### 技術スタック

| コンポーネント | 技術 | 理由 |
|--------------|------|------|
| キュー管理 | Supabase（既存経理ハブと共有） | 運用中、追加コストゼロ |
| 設計書生成 | Gemini（分類・構造化） | §2.8の「分類/抽出/要約=Groq/DeepSeek/Gemini」準拠 |
| 執筆エンジン | codex-do.mjs → Codex | §1.17 Codex委譲、費用定額 |
| QC判定 | LLM判定（Gemini/DeepSeek） | 22項目のうち属人的項目はLLM評価 |
| 管理画面 | 経理ハブに追加 / 単一HTML | 経理ハブは既存Next.js、追加1画面 |
| 公開連携 | Markdown→tetsuko.co.jp連携 | 既存サイト構成に合わせる |

### コスト見積もり

| 項目 | 単価 | 月間想定使用量 | 月額 |
|------|------|---------------|------|
| Gemini API（設計書生成+QC） | 従量 | 12記事×2回+QC22×12 | 〜$5 |
| Codex（執筆） | $10/月（定額） | — | $10 |
| Supabase（キュー管理） | 無料枠内 | — | $0 |
| **合計** | | | **〜$15/月** |

### 初回試行手順

#### Step 1: 設計書テンプレート作成（本セッションで実施）

以下の展示会ブース事例テンプレートをJSON形式で作成する：

```json
{
  "keyword": "展示会 ブース制作 事例",
  "targetChars": 3000,
  "titleTemplate": "【事例】{{company_name}}の展示会ブース制作｜{{year}}年{{event_name}}",
  "h2Structure": [
    { "heading": "出展の背景と課題", "targetChars": 400, "factKeys": ["client", "event", "challenge"] },
    { "heading": "ブースデザインのコンセプト", "targetChars": 500, "factKeys": ["concept", "designPoints"] },
    { "heading": "施工プロセスと工夫", "targetChars": 500, "factKeys": ["process", "schedule"] },
    { "heading": "来場者の反応と成果", "targetChars": 400, "factKeys": ["results", "visitorCount"] },
    { "heading": "{{client}}の声", "targetChars": 300, "factKeys": ["testimonial"] },
    { "heading": "株式会社オージャストにできること", "targetChars": 400, "factKeys": ["companyCapabilities"] },
    { "heading": "まとめ", "targetChars": 200, "factKeys": ["summary"] }
  ],
  "faqCount": 4,
  "style": "ですます調、専門用語には初出時に平易な説明、簡潔で読みやすい文体",
  "prohibitedWords": ["驚愕", "必見", "今すぐ", "業界No.1"],
  "requiredKeywords": ["展示会", "ブース制作", "オージャスト", customPerClient]
}
```

#### Step 2: 既存事例で1本生成（codex-do委譲）

1. 設計書JSONに実際の事例データ（顧客名、年、イベント名等）を投入
2. `node tools/codex-do.mjs "design/booth-article-template.json の設計書に従い展示会ブース事例記事を執筆" --cwd "..." --kind code`
3. 22項目QC自動チェック
4. 合格した記事を管理画面に保存

#### Step 3: キューシステム構築

キュー設計：

```sql
-- Supabase
CREATE TABLE article_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec JSONB NOT NULL,           -- 設計書全文
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|processing|qc|passed|failed|published
  agent_id TEXT,                  -- 担当エージェントID
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3,
  qc_result JSONB,               -- QC22項目結果
  article_body TEXT,              -- 生成記事
  error TEXT
);

-- 同時実行制御用（最大20）
CREATE TABLE agent_slots (
  slot_id INT PRIMARY KEY,        -- 1-20
  status TEXT DEFAULT 'available', -- available|busy
  current_article_id UUID,
  heartbeat TIMESTAMPTZ
);
```

### 期待される効果

| 指標 | 現状 | 目標（3ヶ月後） |
|------|------|----------------|
| 事例記事公開数 | 不定期（年数本） | 月2本定期公開 |
| 1記事あたり作成時間 | 2〜3時間（手動） | 30分（QC含む） |
| 記事の品質（修正箇所） | 初稿は大幅修正 | 3〜5か所軽微修正 |
| SEO効果（検索流入） | 事例ページ未計測 | 月間100セッション/記事 |
| LLMO効果（AI引用） | 未計測 | Perplexity/Geminiに3サイト以上引用 |

## 検証・限界

- **未実測の明示**: 本稿のシステム設計は外部記事の分析に基づく設計であり、実装・テストはこれから行う。初回実装時にコードを実際に動かし、QC22項目の実効性を確認する。
- **QC項目の属人性**: 文体・冗長性などLLM判定が難しい項目は、閾値を厳しめに設定し、不合格時の再生成を前提とする。
- **Codexの並列上限**: 最大20並列とあるが、実際のCodex並列数とrate limitは契約に依存する。初回は3並列から開始し、徐々に増やす。
- **画像生成**: 本システムはテキスト記事の生成を目的とし、画像は別途用意する（撮影済み写真の挿入 or DALL-E等で生成）。
- **公開連携**: tetsuko.co.jpへの自動公開連携はPhase 3以降で検討。Phase 1-2はMarkdownファイル出力として管理。

## 次のアクション（このPRで実施する内容）

1. ✅ 本設計書の作成（X-0005ランブック）
2. 🔲 設計書JSON Schemaの実装（`schemas/article-spec.json`）
3. 🔲 展示会ブース事例テンプレートの作成（`templates/booth-example.json`）
4. 🔲 QC22項目チェッカーの試作（`tools/article-qc-checker.mjs`）
5. 🔲 1本テスト生成（codex-do委譲）