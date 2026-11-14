# X-0050: バッチAPIはキャッシュとティア選択の後に — 50%割引を最大活用する3段階最適化

**AIニュース提案 X-0050**: Anthropic Batch API（Message Batches API）は標準価格の50%で利用可能。しかしバッチAPIは「何でもかんでもバッチに突っ込む」ではなく、**能力ティアの最適化→プロンプトキャッシング→バッチ**の順で適用することで最大のコスト削減効果を得られる。Haiku 5.5のリアルタイム推論がSonnet 5.5のバッチより安い事例、キャッシュ割引とバッチ割引の積み重ねで最大87.5%オフになる試算を提示する。

観測日: 2026-11-15

---

## 1. 概要

Anthropic Message Batches APIは、同一のMessages APIリクエストを非同期で処理することで**標準価格の50%オフ**を実現する。しかし本提案の核心は「バッチAPIに回す前にやるべきことがある」という点にある。

### 3段階最適化の順序（この順が重要）

```
① 能力ティアの選択（最も安いモデルで要件を満たせるか）
   ↓
② プロンプトキャッシング（共通プレフィックスをキャッシュ）
   ↓
③ バッチAPI（24時間待てるものを非同期処理）
```

**この順序が重要な理由**:
- Haiku 5.5のリアルタイム（$0.10入/$0.50出）はSonnet 5.5のバッチ（$1.00入/$5.00出）より**10倍安い** — ティア選択を間違えるとバッチ割引の前に土台が高くなる
- バッチ割引は**キャッシュ割引後の残額に適用される** — キャッシュを先に効かせるとバッチの割引ベースが小さくなる
- 適格トラフィックが60%なら節約30%、20%なら節約10% — バッチだけで見ると効果は限定的だが、キャッシュと組み合わせると出力トークンも含めて最大87.5%オフ

### 節約の積み重ね

```
標準価格（Sonnet 5.5）:              $2.00入/$10.00出（1Mトークンあたり）
├─ 能力ティア最適化（Haiku 5.5）:      $0.10入/$0.50出（−95%）
├─ キャッシュ読み取り（Sonnet 5.5）:   $0.50入/$10.00出（−75%入力）
├─ キャッシュ＋バッチ（Sonnet 5.5）:   $0.25入/$5.00出（−87.5%入力/−50%出力）
└─ ティア＋キャッシュ＋バッチ（Haiku）: $0.0125入/$0.25出（−99.4%入力/−97.5%出力）
```

---

## 2. Message Batches API の仕様

### 基本情報

| 項目 | 値 |
|------|-----|
| 割引率 | 標準価格の**50%オフ**（全トークン種別対象） |
| 最大リクエスト数 | バッチあたり100,000件 |
| 最大サイズ | 256 MB |
| 完了時間 | 大部分は1時間以内、最大24時間 |
| 結果保持期間 | 29日間 |
| 対応機能 | vision / tools / caching（対応） |
| 非対応機能 | stream / speed / fallbacks / max_tokens: 0 |

### 割引が効くトークン

バッチAPIの50%割引は以下の**すべてのトークン種別**に適用される：

| トークン種別 | 標準価格（Sonnet 5.5） | バッチ価格 |
|-------------|---------------------|-----------|
| 入力（通常） | $2.00/1M | **$1.00/1M** |
| 入力（キャッシュ書込） | $2.50/1M（1.25x） | **$1.25/1M** |
| 入力（キャッシュ読取） | $0.50/1M（0.25x） | **$0.25/1M** |
| 出力 | $10.00/1M | **$5.00/1M** |

**バッチ内のキャッシュはベストエフォート**：同時実行されるバッチリクエスト間のキャッシュヒットは保証されない。同一プレフィックスのリクエストを連続してバッチ投入する場合、キャッシュのタイミングが合わない可能性がある。

### APIの使い方

```typescript
// バッチ作成
const batch = await client.messages.batches.create({
  requests: [
    {
      custom_id: "booth-proposal-001",
      params: {
        model: "claude-sonnet-5-5",
        max_tokens: 4000,
        messages: [
          { role: "user", content: "3m x 3m小間の..." }
        ],
      },
    },
    // ...最大100,000件まで
  ],
});

// 完了をポーリング
let batchStatus;
do {
  batchStatus = await client.messages.batches.retrieve(batch.id);
  await new Promise(r => setTimeout(r, 60000));
} while (batchStatus.processing_status !== "ended");

// 結果を取得（custom_idで識別）
for await (const result of await client.messages.batches.results(batch.id)) {
  if (result.result.type === "succeeded") {
    console.log(`[${result.custom_id}] OK`);
  }
}
```

---

## 3. なぜ①ティア選択が最初なのか

### 料金比較（1Mトークンあたり）

| モデル | 入力（標準） | 出力（標準） | 入力（バッチ） | 出力（バッチ） |
|-------|-----------|-----------|-------------|-------------|
| Claude Opus 5.5 | $4.00 | $20.00 | $2.00 | $10.00 |
| Claude Sonnet 5.5 | $2.00 | $10.00 | **$1.00** | **$5.00** |
| Claude Haiku 5.5 | **$0.10** | **$0.50** | **$0.05** | **$0.25** |

### 「Haikuリアルタイム vs Sonnetバッチ」の比較

| シナリオ | コスト（1M入/出） | 応答時間 |
|---------|----------------|---------|
| Sonnet 5.5 リアルタイム | $2.00 / $10.00 | 即時 |
| Sonnet 5.5 バッチ | $1.00 / $5.00 | 〜24h |
| Haiku 5.5 リアルタイム | **$0.10 / $0.50** | **即時** |
| Haiku 5.5 バッチ | $0.05 / $0.25 | 〜24h |

**結論**: Haiku 5.5リアルタイム（$0.10/$0.50）はSonnet 5.5バッチ（$1.00/$5.00）より**10倍安く、しかも即時応答**。タスクの品質要件がHaikuで満たせるなら、バッチに回す前にモデル自体をHaikuに変える方が圧倒的に効果的。

### ティア選択の判断基準

| タスク種別 | 適性モデル | 理由 |
|-----------|----------|------|
| 展示会後レポートの要約 | Haiku 5.5 | 指示が明確で創造性不要 |
| ブース案の大量生成（10〜20案） | Sonnet 5.5 | 品質と多様性が必要 |
| 見積自動生成（定型フォーマット） | Haiku 5.5 | テンプレートに沿った出力 |
| 施工手順書の初稿 | Sonnet 5.5 | 安全に関わる正確性 |
| 顧客問い合わせの一次分類 | Haiku 5.5 | 分類タスクはHaikuで十分 |

---

## 4. なぜ②キャッシュがバッチの前なのか

### キャッシュ割引とバッチ割引の積み重ね

バッチの50%割引は**キャッシュ割引後の金額に適用される**。つまり：

```
Sonnet 5.5 入力1Mトークンの場合:

 ① 標準価格:           $2.00
 ② キャッシュ読取(75%off): $0.50  ← まずキャッシュ
 ③ キャッシュ読取→バッチ:   $0.25  ← 次にバッチ（②の50%）
 ─────────────────────────
 ①→③の削減率: 87.5%
```

キャッシュ割引（最大75%オフ）の絶対額はバッチ割引（50%オフ）より大きい。よって「キャッシュを先に効かせて、その残額にバッチを適用する」のが正しい順序。

### キャッシュ＋バッチの実践的パターン

**バッチ投入前にキャッシュをウォームアップする**:

```typescript
// Step 1: キャッシュウォームアップ（1リクエストのみ）
const warmup = await client.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 1,        // 最小出力でキャッシュ書込コストを抑える
  cache_control: { type: "ephemeral" },
  system: FIXED_SYSTEM_PROMPT,  // 共通プレフィックス
  messages: [{ role: "user", content: "ping" }],
});

// Step 2: バッチ投入（キャッシュが生きている5分以内）
const batch = await client.messages.batches.create({
  requests: BATCH_REQUESTS.map((req, i) => ({
    custom_id: `req-${i}`,
    params: {
      model: "claude-sonnet-5-5",
      max_tokens: 4000,
      cache_control: { type: "ephemeral" },
      system: FIXED_SYSTEM_PROMPT, // ウォームアップと同じ → キャッシュヒット
      messages: [{ role: "user", content: req.prompt }],
    },
  })),
});
```

**効果**: バッチ内の全リクエストがキャッシュ読み取り（75%オフ）＋バッチ割引（50%オフ）＝合計87.5%オフで処理される。キャッシュウォームアップの1リクエストは1.25xの書き込みコストがかかるが、100件のバッチなら**十分に元が取れる**。

### キャッシュTTLとバッチの関係

| シナリオ | キャッシュ戦略 | リスク |
|---------|-------------|-------|
| バッチ投入が5分以内に完了 | エフェメラル（5分TTL） | 同時実行バッチはベストエフォート |
| バッチ投入が1時間程度 | 1時間TTL（2x書込） | 書込コストが倍になるが、バッチ内ヒット率は向上 |
| バッチ投入が不定期 | バッチ直前にウォームアップ | ウォームアップのコストが常に発生 |

---

## 5. ③バッチAPIの適用判断

### 適格判断フローチャート

```
このタスク、24時間待てる？
├─ NO  → リアルタイムAPI（通常）
└─ YES → このタスク、Haikuで品質足りる？
          ├─ YES → Haiku リアルタイム（即時・最安）
          └─ NO  → このタスク、共通プレフィックスはある？
                    ├─ NO  → Sonnet バッチ（50% off）
                    └─ YES → Sonnet キャッシュ＋バッチ（最大87.5% off）
```

### 適格トラフィック割合と削減率

バッチAPIの全体的な削減効果は、全トラフィックのうち「24時間待てる割合」に依存する：

| 適格トラフィック割合 | 全体の削減率 | 備考 |
|-------------------|------------|------|
| 100% | 50% | 全タスクをバッチ化 |
| 60% | 30% | 要約・バッチ生成など |
| 20% | 10% | 夜間処理のみ |
| 0% | 0% | チャット・即時応答のみ |

### オージャストでの適用ユースケース

| ユースケース | 待てる時間 | 適性モデル | キャッシュ | 推定削減率 |
|------------|----------|----------|---------|----------|
| 展示会後レポート要約（5〜10件） | 数時間 | Haiku 5.5 or Sonnet 5.5 | 共通フォーマット | 70〜87.5% |
| ブース案大量生成（10〜20案） | 数時間 | Sonnet 5.5 | 会社概要＋制約条件 | 61〜87.5% |
| 過去事例からの類似案件検索 | 24時間 | Haiku 5.5 | 検索テンプレート | 70〜95% |
| 見積書の一括再計算 | 夜間 | Haiku 5.5 | フォーマット定義 | 80〜95% |
| 施工手順書の一括生成 | 夜間 | Sonnet 5.5 | 安全基準＋共通手順 | 61〜87.5% |
| 顧客フィードバックの分析 | 24時間 | Haiku 5.5 | 分析カテゴリ定義 | 70〜95% |

---

## 6. 費用対効果の試算（オージャスト月間想定）

### 前提条件
- 月間API支出: $200（全モデル合計）
- バッチ適格タスク: 40% = $80相当
- キャッシュ適格タスク: 60%（バッチ適格タスクのうち80%に共通プレフィックス）

### 段階的削減の試算

| 段階 | 施策 | 月間コスト | 削減額 | 累積削減率 |
|------|------|----------|--------|----------|
| 0 | 現状（最適化なし） | $200.00 | — | — |
| 1 | 能力ティアの最適化（Haikuへの切替） | $140.00 | $60.00 | 30% |
| 2 | プロンプトキャッシング導入 | $98.00 | $42.00 | 51% |
| 3 | バッチAPI導入 | $77.00 | $21.00 | **61.5%** |

### 重要な気付き

- ティア最適化（$60削減）＞キャッシュ（$42削減）＞バッチ（$21削減）
- バッチ単独の削減額は小さいが、**キャッシュ後の残額にかかるため実効的な削減率は高い**
- 3段階すべて実施で月間$123削減（年間$1,476）

---

## 7. 実装のベストプラクティス

### 7.1 バッチの設計

```typescript
// 悪い例: キャッシュ考慮なし
const badBatch = await client.messages.batches.create({
  requests: items.map((item, i) => ({
    custom_id: `item-${i}`,
    params: {
      model: "claude-sonnet-5-5",
      max_tokens: 4000,
      system: FULL_SYSTEM,          // 毎回異なるシステムプロンプト → キャッシュ不可
      messages: [{ role: "user", content: item.prompt }],
    },
  })),
});

// 良い例: 共通プレフィックスを先にキャッシュ
const warmup = await client.messages.create({
  model: "claude-sonnet-5-5", max_tokens: 1,
  cache_control: { type: "ephemeral", ttl: "1h" },  // 1時間キャッシュ
  system: COMMON_SYSTEM,
  messages: [{ role: "user", content: "warmup" }],
});

const goodBatch = await client.messages.batches.create({
  requests: items.map((item, i) => ({
    custom_id: `item-${i}`,
    params: {
      model: "claude-sonnet-5-5",
      max_tokens: 4000,
      cache_control: { type: "ephemeral" },
      system: COMMON_SYSTEM,          // ウォームアップと同じ → キャッシュヒット
      messages: [{ role: "user", content: item.prompt }],
    },
  })),
});
```

### 7.2 エラーハンドリング

バッチAPIでは各リクエストが独立して成功/失敗する：

```typescript
for await (const result of await client.messages.batches.results(batch.id)) {
  switch (result.result.type) {
    case "succeeded":
      // 正常
      break;
    case "errored":
      if (result.result.error.type === "invalid_request") {
        // バリデーションエラー（修正して再投入）
      } else {
        // サーバーエラー（再試行可能）
      }
      break;
    case "expired":
      // 期限切れ（再投入）
      break;
  }
}
```

### 7.3 自動パイプライン化

夜間バッチ処理の推奨パターン：

```
毎日 20:00 → バッチAPIに投入
         → （バックグラウンドで処理）
毎朝 06:00 → 結果を確認 → 未完了ならポーリング継続
         → 結果をDB/ファイルに保存
         → エラーを通知
```

---

## 8. 制約と注意点

| 項目 | 内容 |
|------|------|
| **同時実行キャッシュ** | バッチ内の同時実行リクエストはキャッシュヒットがベストエフォート（保証されない） |
| **ウォームアップ必須** | 初回バッチはキャッシュが空 → ウォームアップリクエストで事前にキャッシュ書込 |
| **TTLとの戦い** | ウォームアップからバッチ投入までの間隔が5分を超えるとキャッシュが切れる |
| **キャンセル不可** | バッチ投入後のキャンセルは可能だが、既に処理済みのリクエストは戻らない |
| **ストリーミング非対応** | バッチAPIでは`stream: true`が使えない |
| **Fallback非対応** | バッチAPIでは`fallbacks`パラメータが使えない |
| **スピード変更不可** | `speed: "fast"` はバッチAPIでは無効 |

---

## 9. 参考文献

- [Anthropic Message Batches API Documentation](https://docs.anthropic.com/en/docs/build-with-claude/message-batches)
- [Anthropic Prompt Caching Guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic Claude API Pricing](https://www.anthropic.com/pricing)
- [X-0035: プロンプトキャッシングで繰り返し入力コストを最大90%削減](ai-news-x0035-prompt-caching-cost-reduction.md)
- [X-0025: プロンプトキャッシュ＋安価ルーティングでコスト70%削減](ai-news-x0025-prompt-cache-cheap-routing.md)
- [X-0030: Claudeモデル選択とコスト最適化 — 用途別の最適モデル選定](ai-news-x0030-claude-model-cost-reduction.md)
- `docs/ai-news-x0022-harness-cost-half.md`
- `docs/ai-news-x0034-model-selection-cost-optimization.md`
- `docs/ai-news-x0037-prompt-cache-cheap-routing.md`