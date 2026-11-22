# X-0057 semantic-cache.mjs 実装指示

## 概要
セマンティックキャッシュ + エントロピー分析 + コストキルスイッチのツール。

## ファイル構成
- `tools/semantic-cache.mjs` — 新規作成
- `tools/semantic-cache.test.mjs` — 新規作成

## tools/semantic-cache.mjs の仕様

### モジュール構成（エクスポート関数）

```js
export function analyzeEntropy(text)
export function semanticCacheLookup(query, cache, options?)
export function semanticCacheStore(query, response, embedding, cache, options?)
export function costKillSwitch(state, limits)
export function createEmbedding(text)
export function semanticRoute(text, options?)
```

### 1. analyzeEntropy(text) → { lexical, structural, combined }

プロンプトのエントロピー（複雑さ）を分析する。

**字句エントロピー (lexical)**:
- テキストを単語/文字に分割し、出現確率分布のシャノンエントロピーを計算
- H = -Σ p(x) × log₂(p(x))
- ただし文字単位（空白除去後）で計算
- 最短1文字でも0.0を返す（エラーにしない）
- 最大長は100,000文字（超えたら0.0を返す）

**構造エントロピー (structural)**:
- 以下の要素をカウントし、0.0〜1.0に正規化:
  - 改行数 / 100（最大0.3）
  - 箇条書き記号（-・*・1.・①等）の数 / 50（最大0.3）
  - 指示語（「して」「ください」「ください。」「を」等）の種類数 / 20（最大0.4）
- 合計を1.0でクリップ

**combined**: lexical * 0.4 + structural * 0.6（0.0〜1.0）

**分類基準**:
- < 0.3: "simple"（定型・単純）
- 0.3〜0.6未満: "medium"（通常タスク）  
- >= 0.6: "complex"（複雑・創造的）

### 2. createEmbedding(text) → number[]

テキストの埋め込みベクトルを生成する（オフライン模擬）。
- 実際の埋め込みAPIは呼ばない
- テキストの文字コードをハッシュ的な疑似ベクトル（長さ64のFloat64Array）に変換
- 文字ごとに文字コードをseedにした簡易疑似乱数でベクトル生成
- 同じテキストからは常に同じベクトルを返す（決定論的）
- 類似テキストからは類似したベクトルを返す（先頭N文字が同じなら差が小さい）

実装の詳細：文字列の先頭から min(テキスト長, 256) 文字を使い、各文字コードと位置を使って 64次元のベクトルを生成する。余弦類似度が意味を持つ程度に、同じ先頭文字列を持つテキストは類似したベクトルになること。

### 3. cosineSimilarity(a, b) → number（内部関数）

2つのFloat64Arrayのコサイン類似度を計算。
- ゼロベクトルは類似度0を返す
- 長さ不一致はエラー

### 4. semanticCacheLookup(query, cache, options?) → { hit: boolean, response?: string, similarity: number, entry?: object }

セマンティックキャッシュを検索する。

**引数**:
- `query`: 検索クエリ文字列
- `cache`: キャッシュデータ。`{ entries: [{ query, response, embedding, timestamp, ttlMs }] }` の形式
- `options.similarityThreshold`: 類似度閾値（既定 0.92）
- `options.now`: 現在時刻（テスト用、既定 Date.now()）

**動作**:
1. queryの埋め込みベクトルを生成
2. cache.entries を走査し、各エントリとのコサイン類似度を計算
3. 類似度 ≥ threshold かつ TTL有効（now - timestamp < ttlMs）のエントリがあれば hit
4. 最も類似度の高いエントリを返す

### 5. semanticCacheStore(query, response, embedding, cache, options?) → cache

応答をセマンティックキャッシュに保存する。

**引数**:
- `options.maxEntries`: 最大エントリ数（既定 1000、超過時は最も古いエントリを削除）
- `options.ttlMs`: デフォルトTTL（既定 3600000 = 1時間）

**動作**:
1. embedding が未指定なら createEmbedding(query) で生成
2. 新しいエントリを cache.entries に追加
3. maxEntries 超過時は timestamp が最も古いエントリを削除
4. 同一クエリ（コサイン類似度 0.99以上）が既存なら、新しいもので上書き

### 6. costKillSwitch(state, limits) → { allowed, reason, suggestedAction }

コストキルスイッチの判定。

**引数**:
- `state`: `{ dailyCalls, dailyCostUsd, monthlyCostUsd, modelCostMultiplier }` 
- `limits`: `{ maxDailyCalls, maxDailyCostUsd, maxMonthlyCostUsd, autoDegrade, degradeThreshold }`

**戻り値**:
- `{ allowed: true, reason: 'ok' }` または
- `{ allowed: false, reason: 'daily_calls_exceeded'|'daily_cost_exceeded'|'monthly_cost_exceeded', suggestedAction: 'stop'|'degrade_to_cheaper'|'wait' }`

**動作**:
1. state.dailyCalls >= limits.maxDailyCalls → 拒否
2. state.dailyCostUsd >= limits.maxDailyCostUsd → 拒否（autoDegradeがtrueなら安価レーンへ縮退）
3. state.monthlyCostUsd >= limits.maxMonthlyCostUsd → 拒否
4. autoDegrade が true かつ monthlyCostUsd / maxMonthlyCostUsd >= degradeThreshold → suggestedAction: 'degrade_to_cheaper'

### 7. semanticRoute(text, options?) → { route, model, entropy, estimatedCostUsd, hit, cacheResponse? }

エントロピー分析 + セマンティックキャッシュ + ルーティングを統合。

**引数**:
- `options.cache`: セマンティックキャッシュ（省略時はキャッシュなし）
- `options.costState`: コスト状態（省略時は制限なし）
- `options.costLimits`: コスト制限
- `options.complexModel`: 複雑タスク用モデル（既定 'openai/gpt-4o'）
- `options.mediumModel`: 中タスク用モデル（既定 'moonshotai/kimi-k3'）
- `options.simpleModel`: 単純タスク用モデル（既定 'deepseek/deepseek-v4-flash'）
- モデルは provider-routing.mjs の gatewayModel を通す必要はない（常に文字列）

**戻り値**:
```js
{
  route: 'simple'|'medium'|'complex',
  model: string,           // 選択されたモデル
  entropy: { lexical, structural, combined },
  estimatedCostUsd: number, // model-routerのestimateCost相当
  cacheHit: boolean,       // キャッシュヒットしたか
  cacheResponse: string|undefined, // キャッシュヒット時の応答
  killSwitched: boolean,   // キルスイッチで制限されたか
  killSwitchAction: string|undefined // キルスイッチの指示
}
```

**動作**:
1. analyzeEntropy(text) でエントロピー分析
2. キャッシュがあれば semanticCacheLookup で検索
3. costKillSwitch で制限確認
4. 制限時は suggestedAction が 'degrade_to_cheaper' なら一段階安価モデルへ、それ以外は killSwitched=true
5. ルートとモデルを決定

### 価格表（model-router.mjs の ROUTING_TABLE と同じ値を使用）:

| ルート | 入力USD/1M | 出力USD/1M |
|--------|-----------|-----------|
| simple | 0.15 | 0.60 |
| medium | 0.50 | 1.50 |
| complex | 2.50 | 10.00 |

## tools/semantic-cache.test.mjs の仕様

`node --test tools/semantic-cache.test.mjs` で全テストが緑になること。

### テストケース

1. **analyzeEntropy: 空文字と短いテキスト**
   - 空文字 '' → lexical=0, structural=0, combined=0
   - 'a' → lexical=0（1文字のエントロピーは0）
   - 日本語1文字 → lexical=0

2. **analyzeEntropy: 複雑なテキスト**  
   - 長い指示文（複数行・箇条書き含む）→ combined >= 0.3
   - 非常に長いテキスト（構造含む）→ combined >= 0.6

3. **analyzeEntropy: 分類基準**
   - 短い単語 → combined < 0.3 → "simple"
   - 中程度のテキスト → 0.3 <= combined < 0.6 → "medium"
   - 複雑なテキスト → combined >= 0.6 → "complex"

4. **createEmbedding: 決定論的**
   - 同じテキストから同じベクトル
   - 長さ64のFloat64Array
   - 異なるテキストから異なるベクトル
   - 類似テキスト同士のコサイン類似度 > 無関係テキスト同士

5. **semanticCacheLookup: ヒットとミス**
   - 空キャッシュ → hit=false
   - 登録済みクエリと類似 → hit=true, similarity >= 0.9
   - 無関係クエリ → hit=false
   - TTL切れ → hit=false

6. **semanticCacheStore: 保存と超過削除**
   - 新規保存 → エントリ数が増える
   - maxEntries超過 → 古いエントリが削除される
   - 同一クエリ上書き → エントリ数が増えない

7. **costKillSwitch: 各種制限**
   - 制限なし → allowed=true
   - dailyCalls超過 → allowed=false
   - dailyCost超過 → allowed=false
   - monthlyCost超過 → allowed=false
   - autoDegrade = degrade_to_cheaper

8. **semanticRoute: 統合パス**
   - キャッシュヒットで cacheHit=true
   - 複雑テキスト → route='complex'
   - 単純テキスト → route='simple'
   - キルスイッチ発動で killSwitched=true
   - キルスイッチ縮退時はモデルが一段階安くなる

### 実装上の注意
- このファイルを編集しない・再委譲しない・テストを緩めない
- model-router.mjs や provider-routing.mjs への依存は不可（独立モジュール）
- ネットワーク通信は一切行わない（オフライン完結）
- Anthropic/Claude モデル指定は禁止（既存ルールに従う）
