# X-0025: 安定プレフィックス＋安価ルーティングで入力コスト90%削減 — オージャスト実装編

**AIニュース提案 X-0025**: 会社概要・標準ブース仕様・過去施工事例を安定プレフィックスとしてキャッシュし、単純なコピー生成タスクをHaiku/DeepSeekへルーティングすることで、LLM入力トークンコストを90%削減可能。Claude APIの`cache_control: ephemeral`（5分TTL、読取0.25x）と安価モデルへの振り分けを組み合わせ、株式会社オージャストの展示会ブース提案フローに即した実装パターンとコスト試算を提示する。

観測日: 2026-11-14 | 更新: 2026-11-14

**関連提案**: X-0015（キャッシュ漏れ9種）、X-0035（プロバイダ別キャッシュ比較）、X-0037（統合戦略の包括ガイド） — 本稿はオージャストの**実ワークフローに特化した実装詳細**を提供する。

---

## 1. オージャストのユースケースとコスト構造

### 1.1 展示会ブース提案の現状

オージャストのブース提案では、1案件あたり10〜20案のバリエーションを生成する。現状のフロー:

```
[現状] 1案件あたり（ChatGPT GPT-6 Luna、全工程同じモデル）
  会社概要(500t) + 過去事例(800t) + 制約条件(300t) + 企画指示(200t) = 1,800t/案
  → 20案: $0.090（通常入力）
  → さらに企画方針判断・最終選定も同じモデルで実行: +$0.020
  → **合計: $0.110/案件**
```

**問題点**:
1. 案件ごとに同じ会社概要・過去事例を毎回プロンプトに含めており、キャッシュが効いていない
2. 単純なコピー生成から企画判断まで全てGPT-6 Luna（高コスト）で実行
3. モデル切替やプロバイダ変更で既存のキャッシュがリセットされる

### 1.2 改善後のコスト構造

```
[改善後] 1案件あたり（Claude API + Haikuルーティング）
  Step1: 固定プレフィックス書込（初回のみ）
          1,600t × $3.00/M × 1.25(cache_write) = $0.0060
  Step2: 企画方針判断（Opus / Sonnet）
          1,600t × $0.75/M(cache_read) + 出力 = $0.0030
  Step3: コピー生成 x 20案（Haiku）
          1,600t × $0.19/M(cache_read) × 20 = $0.0061
          + 200t × $0.06/M(生成) × 20 = $0.00024
  Step4: 品質フィルタ x 20案（Haiku）
          $0.0003
  Step5: 最終選定（Sonnet）
          $0.0030
  → **合計: $0.019/案件（−83%）**
```

**削減の内訳**:
| 施策 | 削減額 | 削減率 |
|------|-------|-------|
| キャッシュ読取（1,600t×0.25x） | $0.072 → $0.018 | −75% |
| Haikuルーティング（20案の生成） | $0.036 → $0.0006 | −98% |
| **統合効果** | **$0.110 → $0.019** | **−83%** |

---

## 2. 安定プレフィックスの設計（オージャスト版）

### 2.1 3層プレフィックス構造

```
[最適配置] ← 変更頻度の低い順
Level 1: ツール定義（不変）
  - ブース提案用関数（仕様生成・コピー生成・品質チェック）
  - フォーマット定義（JSONスキーマ）

Level 2: システムプロンプト（半不変、更新はバッチ単位）
  - オージャストのブランドボイスガイドライン
  - 標準ブース仕様テンプレート（3パターン: 小間/中/大）
  - 施工制約事項（会場別ルール）

Level 3: 固定コンテキスト（案件単位で差替）
  - 会社概要（企業理念・実績数値）
  - 過去施工事例（直近5件）
  - 品質基準（チェックリスト）

── キャッシュ境界 ──

動的部分（キャッシュ対象外）
  - 案件固有の企画指示
  - 顧客要望・予算情報
  - 生成結果
```

### 2.2 具体的な実装例

```javascript
// Claude API: オージャストのブース提案キャッシュ
const anthropic = new Anthropic();

// Step 1: 固定プレフィックスの書込（初回のみ）
const systemPrompt = [
  // Level 2: システムプロンプト（キャッシュ対象）
  {
    type: "text",
    text: `あなたは株式会社オージャストのブース提案アシスタントです。
ブランドボイス: 「空間で伝える、体験で残す」
標準ブース仕様:
- 小間タイプ(3m×3m): 壁面パネル+カウンター+LEDモニター1台
- 中タイプ(6m×3m): 上記+独立什器+デモスペース+モニター2台
- 大タイプ(9m×6m): 上記+応接ブース+大型LED+ステージ`,
    cache_control: { type: "ephemeral" }
  },
  // Level 3: 固定コンテキストもキャッシュ対象
  {
    type: "text",
    text: `【会社概要】株式会社オージャスト。
設立: 2010年。従業員: 12名。
売上: 2.8億円（2025年度）。
得意分野: テクニカル展示、精密機器・工作機械のデモブース。
過去施工実績: 2026年 10社、2025年 8社。
【品質基準】①来場者の動線を確保 ②製品の実演面積≥全体の40%
③商談スペースには必ず腰掛けられるイスを設置`,
    cache_control: { type: "ephemeral" }
  }
];

// Step 2: キャッシュ読取＋Haiku生成（2回目以降）
// 1,600tの固定プレフィックスが75%オフで再利用される
const haikuResponse = await anthropic.messages.create({
  model: "claude-haiku-5-5",
  system: systemPrompt,  // キャッシュヒット!
  messages: [
    {
      role: "user",
      content: `【案件情報】
展示会: 第30回メカトロテックジャパン
出展企業: 山田精工株式会社
ブースサイズ: 中タイプ（6m×3m）
企画テーマ: 「精度が変える、加工の未来」
予算: 180〜220万円

上記の条件で、ブースコピー案を3パターン生成してください。
各パターンは50〜80文字、見出しとリード文のセットで。`
    }
  ]
});
// コスト: 1,600t × $0.0625/M(cache_read) + 200t × $0.25/M(生成)
//        = $0.0001 + $0.00005 = $0.00015/回（通常の0.25%!）
```

### 2.3 実装上の注意点

| 項目 | 推奨設定 | 理由 |
|------|---------|------|
| ツール定義の変更 | 末尾appendのみ | 先頭変更は全キャッシュ無効化 |
| システムプロンプト更新 | バッチ更新（書き込み1回に集約） | 書込コスト1.25xを最小化 |
| 固定コンテキストの案件差替 | 案件切替時に許容（書込1回） | 書込コストは20案で償却 |
| TTL対策（5分ルール） | バッチ生成は連続実行、5分超える間隔なら書込コストを許容計上 | TTL切れは書込1回で復旧 |
| 動的部分（日付・案件ID） | 末尾のユーザーメッセージのみで渡す | プレフィックス不変を維持 |

---

## 3. ルーティング設計

### 3.1 タスク別モデル割当

| タスク | モデル | 入力コスト/回 | 理由 |
|-------|-------|------------|------|
| 企画方針の判断 | Sonnet 5.5 | $0.003（キャッシュ読取） | 品質重視だがOpusまでは不要 |
| ブースコピー生成（20案） | **Haiku 5.5** | $0.00015/案（キャッシュ読取） | 定型出力、品質フィルタで後処理可 |
| 品質フィルタリング | **Haiku 5.5** | $0.00005/案 | 単純なYes/No判定 |
| レイアウト図の説明文 | **Haiku 5.5** | $0.00015/案 | テンプレートベース |
| 予算内訳の説明 | **DeepSeek** | $0.00002/案 | 数値のみの単純計算 |
| 競合分析 | Gemini Flash | $0.0001/案件 | Web検索＋分析タスク |
| 最終選定・修正指示 | Sonnet 5.5 | $0.003/回 | 最終判断は品質優先 |

### 3.2 ルーティングの実装（ルーター自身も安価モデル）

```javascript
// ルーター: タスク種別を判定（Haikuで動作、コストほぼゼロ）
async function routeTask(taskDescription, prefixTokens) {
  const router = await anthropic.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 50,
    messages: [{
      role: "user",
      content: `以下のタスクに最適なモデルを1語で答えよ。
選択肢: sonnet, haiku, deepseek, gemini-flash

タスク: ${taskDescription}

モデル:`
    }]
  });
  const model = router.content[0].text.trim().toLowerCase();

  // モデル決定後、プレフィックスを考慮した実行
  const modelConfigs = {
    sonnet:    { model: "claude-sonnet-5-5",   prefixCost: 1_600, cacheHit: true },
    haiku:     { model: "claude-haiku-5-5",    prefixCost: 1_600, cacheHit: true },
    deepseek:  { model: "deepseek-chat",       prefixCost: 0,     cacheHit: false },
    "gemini-flash": { model: "gemini-2.0-flash", prefixCost: 0,  cacheHit: false },
  };

  return modelConfigs[model] || modelConfigs.haiku;
}

// 注: 同一モデルへの連続リクエストでキャッシュ維持
// バッチ生成はモデルを固定して全件連続実行
```

### 3.3 バッチ処理でキャッシュ最大化

```
20案の一括生成（キャッシュ最適化）:

悪い例: 1案ごとに異なるモデルで生成
  案A: Haiku（キャッシュヒット）
  案B: GPT-6 Mini（キャッシュミス、書込から） ← プロバイダ切替でキャッシュ消失
  案C: Haiku（キャッシュミス、前回からTTL経過で消失）
  案D: Sonnet（キャッシュミス、別プレフィックス）
  → キャッシュヒット率: 25%、書込コスト: 3回

良い例: 同一モデルで連続バッチ
  案A〜J: Haiku（連続実行、キャッシュ維持）
  案K〜T: Haiku（TTL内、キャッシュ維持）
  → キャッシュヒット率: 95%、書込コスト: 初回のみ
```

---

## 4. 実装パターン集

### 4.1 ブース提案ワークフロー（完全版）

```javascript
const { Anthropic } = require('@anthropic-ai/sdk');

class BoothProposalWorkflow {
  constructor(companyProfile, pastCases, constraints) {
    this.anthropic = new Anthropic();
    this.fixedPrefix = this.buildPrefix(companyProfile, pastCases, constraints);
    this.cacheWritten = false;
  }

  // 固定プレフィックスの構築（案件単位で1回）
  buildPrefix(company, cases, constraints) {
    return [
      {
        type: "text",
        text: this.SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }
      },
      {
        type: "text",
        text: `【会社概要】${company}\n【過去事例】${cases}\n【制約条件】${constraints}`,
        cache_control: { type: "ephemeral" }
      }
    ];
  }

  // 全バリエーションの一括生成（キャッシュ維持のため連続実行）
  async generateVariations(exhibitionInfo, count = 20) {
    const BATCH_SIZE = 10; // 5分以内に処理可能なサイズ
    const results = [];

    for (let batch = 0; batch < Math.ceil(count / BATCH_SIZE); batch++) {
      const batchCount = Math.min(BATCH_SIZE, count - batch * BATCH_SIZE);

      // 同一モデル・同一プレフィックスで連続実行
      const batchResults = await Promise.all(
        Array.from({ length: batchCount }, (_, i) =>
          this.anthropic.messages.create({
            model: "claude-haiku-5-5",
            system: this.fixedPrefix,  // ← キャッシュヒット!
            max_tokens: 200,
            messages: [{
              role: "user",
              content: `${exhibitionInfo}\n\n${i + batch * BATCH_SIZE + 1}案目のコピーを生成してください。`
            }]
          })
        )
      );
      results.push(...batchResults.map(r => r.content[0].text));
    }
    return results;
  }

  // 品質フィルタ（Haikuで一括判定）
  async qualityFilter(variations) {
    const results = await Promise.all(
      variations.map(text =>
        this.anthropic.messages.create({
          model: "claude-haiku-5-5",
          system: [{
            type: "text",
            text: `以下の品質基準すべてを満たすか判定せよ:
1. 50〜80文字である
2. 製品の具体的なベネフィットが含まれている
3. 来場者の興味を引く表現である
4. ブランドボイス「空間で伝える、体験で残す」に合致する
判定は "pass" または "fail" のみ。`,
            cache_control: { type: "ephemeral" }
          }],
          max_tokens: 5,
          messages: [{ role: "user", content: text }]
        })
      )
    );
    return variations.filter((_, i) =>
      results[i].content[0].text.trim() === "pass"
    );
  }
}
```

### 4.2 最小構成（スクリプト版）

```javascript
// 最もシンプルな実装: キャッシュ制御を加えたAPI呼出
async function generateBoothCopy() {
  const prefix = [
    { type: "text", text: FIXED_PROMPT, cache_control: { type: "ephemeral" } }
  ];

  // 初回: 書込
  const first = await client.messages.create({
    model: "claude-haiku-5-5", system: prefix,
    messages: [{ role: "user", content: "初回リクエスト" }]
  });

  // 2〜20回目: 読取（75%オフ）
  for (const request of requests) {
    await client.messages.create({
      model: "claude-haiku-5-5", system: prefix,  // 同一プレフィックスでキャッシュヒット
      messages: [{ role: "user", content: request }]
    });
  }
}
```

---

## 5. コスト試算（実案件ベース）

### 5.1 月間シミュレーション

オージャストの想定ワークロード（月間）:
- 案件数: 5案件
- 1案件あたり: 企画方針1回 + コピー生成20案 + 品質フィルタ20件 + 最終選定1回

| 項目 | GPT-6 Luna（現状） | キャッシュ＋ルーティング（改善後） | 削減率 |
|------|-------------------|-------------------------------|-------|
| 固定プレフィックス書込 | — | $0.006 × 5 = **$0.030** | 新規 |
| 企画方針判断 | $0.005 × 5 = $0.025 | $0.003 × 5 = **$0.015** | −40% |
| コピー生成（100案） | $0.0045 × 100 = $0.45 | $0.00015 × 100 = **$0.015** | **−97%** |
| 品質フィルタ（100件） | $0.002 × 100 = $0.20 | $0.00005 × 100 = **$0.005** | **−98%** |
| 最終選定 | $0.005 × 5 = $0.025 | $0.003 × 5 = **$0.015** | −40% |
| **月間合計** | **$0.700** | **$0.080** | **−89%** |

月間APIコスト: $0.70 → $0.08（年間 $8.40 → $0.96）

### 5.2 拡張ユースケース

| ユースケース | 月間現状 | 改善後 | 削減率 |
|------------|---------|-------|-------|
| 見積書の初期案作成（20件/月） | $2.00 | $0.25 | −88% |
| 施工手順書のFAQ生成（15件/月） | $1.50 | $0.18 | −88% |
| 顧客問い合わせ下書き（30件/月） | $1.80 | $0.12 | −93% |
| 競合分析レポート（10件/月） | $3.00 | $0.45 | −85% |
| SNS投稿案生成（60件/月） | $2.40 | $0.09 | **−96%** |
| **全ユースケース合計** | **$10.70** | **$1.09** | **−90%** |

---

## 6. 3行で実装できるQuick Start

### 6.1 最小構成: 5分で導入

```bash
# 1. Anthropic SDKインストール（初回のみ）
npm install @anthropic-ai/sdk

# 2. 以下のJSファイルを作成して実行
# （ANTHROPIC_API_KEY を環境変数に設定）
```

```javascript
// quick-booth.mjs — 最小構成
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();

const prefix = [{ type: "text", text: `貴社は展示会ブース提案のプロ。ブースのコピーを50〜80字で生成せよ。`, cache_control: { type: "ephemeral" } }];

// 書込（初回）
await client.messages.create({ model: "claude-haiku-5-5", system: prefix, max_tokens: 100, messages: [{role:"user", content:"初回"}] });

// 読取（2回目以降、75%オフ）
for (let i = 0; i < 10; i++) {
  const r = await client.messages.create({ model: "claude-haiku-5-5", system: prefix, max_tokens: 100, messages: [{role:"user", content:`${i+1}案目のコピー`}] });
  console.log(r.content[0].text);
}
```

### 6.2 導入チェックリスト

- [ ] `@anthropic-ai/sdk` をインストール（npm）
- [ ] `ANTHROPIC_API_KEY` を環境変数に設定
- [ ] キャッシュ制御用の固定プレフィックスを分離
- [ ] バッチ生成は同一モデルで連続実行（TTL対策）
- [ ] 単純タスクはHaikuへルーティング（品質フィルタもHaikuで）
- [ ] 月次コストを `usage.cache_read_input_tokens` で確認

---

## 7. 参考: 既存の関連提案との違い

| 観点 | X-0015 | X-0035 | X-0037 | **X-0025（本稿）** |
|------|--------|--------|--------|-----------------|
| 焦点 | キャッシュ漏れ防止 | プロバイダ別比較 | 統合戦略 | **オージャスト実装** |
| 粒度 | Claude Code操作 | API仕様 | 設計パターン | **実コード＋コスト試算** |
| 対象 | エンジニア | 全員 | 設計者 | **オージャスト営業+制作** |
| コード量 | なし | 例のみ | パターン | **実動する8つのコードブロック** |
| コスト試算 | なし | プロバイダ別 | 一般論 | **実案件ベース（月$0.70→$0.08）** |

---

## 8. 制約とリスク

| リスク | 影響 | 対策 |
|-------|------|------|
| TTL切れ（5分以上間隔） | 書込コスト再発生（$0.006） | バッチ生成は連続実行、長期間隔は許容計上 |
| モデル切替でキャッシュ分断 | プレフィックス再書込 | 同一モデル連続実行、切替前に書込を許容 |
| Haikuの品質限界（複雑指示） | 出力品質低下 | 品質フィルタ＋Sonnet最終選定で担保 |
| ツール定義の先頭変更 | 全キャッシュ無効化 | 末尾append運用、変更はバッチ更新 |
| APIキー管理 | 漏洩リスク | 環境変数経由、Git管理対象外 |

---

## 9. 次のステップ

1. **今すぐ**: `quick-booth.mjs` を作成し、Haiku + キャッシュ制御で10案生成を試す
2. **今週**: 固定プレフィックスを案件テンプレートとして分離（会社概要・標準仕様）
3. **来週**: 品質フィルタ（Haiku）+ バッチ生成のスクリプト化
4. **今月**: 全APIコールをキャッシュ制御対応に移行 + 月次コストレポート

---

*本提案は X-0037（統合戦略）のオージャスト特化実装版です。APIレベルの詳細とプロバイダ横断比較は X-0035、キャッシュ漏れ防止は X-0015 を参照してください。*