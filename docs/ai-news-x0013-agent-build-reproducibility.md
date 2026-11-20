# X-0013: エージェント構築の再現手順 — ツール駆動設計と検証ファースト

観測日: 2026-11-10。出典: AIニュース提案 [X-0013]。
本稿は、AIエージェントを構築する際に「毎回同じ品質で再現できる」状態を得るための**エージェント構築の再現手順**を提案する。ツールの使い方の文書化、ループ回避の設計、テストファーストの検証、トークン節約のテクニックを、オージャストのブース関連自動化エージェントを具体例として定義する。

---

## 従来の課題

| 問題 | 説明 | 結果 |
|------|------|------|
| エージェントの振る舞いが属人化する | プロンプトの微調整やツール呼び出しの順序が頭の中にしかない | 別のAIや人が再現しようとすると異なる結果になる |
| ツールがスカラー入力しか受け付けない | 1件ずつループで呼び出すため、ターン数が肥大する | トークン消費が爆発し、コストが制御不能になる |
| テスト不足のまま結合する | ツール単体の検証なしにエージェント全体を動かす | どのコンポーネントが原因か切り分け不能 |
| コンテキスト制約を無視する | 20Bモデルに8Kトークンを超える入力を与える | 途中で文脈が切れ、一貫性のない出力になる |

## 提案: 5原則の再現手順

```
         ┌─────────────────────────────────┐
         │  1. ツールを文書化する          │
         │     (markdownで使い方を記述)     │
         └──────────────┬──────────────────┘
                        ▼
         ┌─────────────────────────────────┐
         │  2. ツールはリストを受け付ける   │
         │     (ループを避ける設計)         │
         └──────────────┬──────────────────┘
                        ▼
         ┌─────────────────────────────────┐
         │  3. ツール→エージェントの順で    │
         │     ユニットテストする            │
         └──────────────┬──────────────────┘
                        ▼
         ┌─────────────────────────────────┐
         │  4. typed units + constrained   │
         │     decoding でトークン節約      │
         └──────────────┬──────────────────┘
                        ▼
         ┌─────────────────────────────────┐
         │  5. 20B/8Kコンテキストに         │
         │     合わせて設計する              │
         └──────────────┬──────────────────┘
                        ▼
         ┌─────────────────────────────────┐
         │  6. Human-in-the-loop を         │
         │     明確に定義する               │
         └──────────────┬──────────────────┘
                        ▼
         ┌─────────────────────────────────┐
         │  7. オージャストのブース自動化    │
         │     エージェントに適用            │
         └─────────────────────────────────┘
```

---

## 1. ツールを文書化する（Markdownファイル）

エージェントが使うツールは、**必ずMarkdownファイルに使い方を記述する**。コードコメントだけでは不十分で、以下の情報を構造化して書く。

### ツール定義テンプレート

```markdown
# tools/<name>.mjs — <一言説明>

## 入力
| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `items`   | `string[]` | 必須 | 処理対象のリスト |
| `options` | `object` | 任意 | 追加設定（下記参照） |

## 出力
| フィールド | 型 | 説明 |
|-----------|-----|------|
| `results` | `object[]` | 処理結果の配列 |
| `errors`  | `string[]` | エラーがあった場合のメッセージ |

## 使用例
```mjs
import { classifyItems } from './tools/classify-items.mjs';
const result = await classifyItems(['keyword1', 'keyword2'], { threshold: 0.7 });
```

## 制約
- 一度に処理するアイテムは最大50件
- タイムアウトは30秒
- 並列実行は不可（レート制限回避）
```

### なぜ文書化が重要か

| 理由 | 説明 |
|------|------|
| **再現性** | 同じツールを別のエージェントや別のAIが使える |
| **テスト容易性** | 入出力の仕様が明確なので、テストケースを書きやすい |
| **監査性** | どのツールがどのパラメータで呼ばれたかを文書と照合できる |
| **メンテナンス性** | ツールの変更がどのエージェントに影響するかを把握できる |

### ドキュメント構成

```
docs/agent-tools/
├── README.md              # ツール一覧と選び方
├── classify-items.md      # 各ツールの詳細
├── fetch-external-data.md
├── format-report.md
└── _template.md           # 新規ツール追加時のテンプレート
```

---

## 2. ツールはリストを受け付け、ループを避ける

AIエージェントの最も一般的な非効率は、**1件ずつループでツールを呼び出す**ことである。ツールがスカラー入力しか受け付けない設計だと、N件の処理にN回のツール呼び出しが必要になり、トークン消費が線形に増える。

### 悪い設計（ループ必須）

```javascript
// 1件ずつしか処理できないツール
async function classifySingleItem(item) {
  const result = await llm.call(`Classify this item: ${item}`);
  return result;
}

// エージェント側でループが必要
const items = ['A', 'B', 'C', ...]; // 100件
const results = [];
for (const item of items) { // 100回のツール呼び出し！
  results.push(await classifySingleItem(item));
}
```

### 良い設計（リストを受け付ける）

```javascript
// リスト全体を一度に処理するツール
async function classifyItems(items, options = {}) {
  const batchSize = options.batchSize || 50;
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    // LLM呼び出しはバッチ単位（バッチ数は固定）
    const response = await llm.call(
      `Classify each item in the following list:\n${batch.join('\n')}`
    );
    results.push(...parseResponse(response));
  }
  return results;
}

// エージェント側は1回の呼び出し
const results = await classifyItems(allItems); // 1回で完了！
```

### ループ削減のパターン

| パターン | スカラー設計 | リスト設計 | 削減効果 |
|---------|------------|-----------|---------|
| 分類 | N回のLLM呼び出し | 1回のバッチLLM呼び出し | 〜N/1 |
| データ取得 | N回のAPI呼び出し | 1回のバルクAPI呼び出し | 〜N/1 |
| 変換 | N回のmap処理 | 1回のバルク変換 | 〜N/1 |
| 検証 | N回のチェック呼び出し | 1回の一括検証 | 〜N/1 |

### 設計ガイドライン

1. **入力は常に配列を基本とする**: 1件の場合も `[item]` で受け付ける
2. **バッチサイズをパラメータ化する**: レート制限やタイムアウトに応じて調整可能にする
3. **エラーは個別に報告する**: バッチ内の一部が失敗しても全体が再実行にならないようにする
4. **進捗をコールバックで報告する**: 長時間処理の場合は部分結果を逐次返す

---

## 3. ツール→エージェントの順でユニットテストする

エージェントのテストで最もありがちな失敗は、**ツール単体のテストをせずにいきなりエージェント全体を動かす**ことである。これにより、バグの切り分けが困難になり、「直したはずなのに直っていない」という無限ループに陥る。

### テストの3層構造

```text
Layer 3: エージェント統合テスト
    ┃  実際のツール連携を検証（少数のシナリオ）
    ┃
Layer 2: ツール結合テスト
    ┃  複数ツールの組み合わせを検証
    ┃
Layer 1: ツールユニットテスト ← ★最初にここを書く
    各ツールを単体で検証（多数のケース）
```

### テスト順序

```bash
# Step 1: ツールユニットテスト（最初に書いて通過させる）
node --test tools/classify-items.test.mjs
node --test tools/fetch-external-data.test.mjs
node --test tools/format-report.test.mjs

# Step 2: ツール結合テスト（ツールが個別に動くことを確認してから）
node --test tools/pipeline.test.mjs

# Step 3: エージェント統合テスト（すべての前提が整ってから）
node --test agents/booth-agent.test.mjs
```

### ツールユニットテストの書き方

```javascript
// tools/classify-items.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyItems } from './classify-items.mjs';

describe('classifyItems', () => {
  it('should classify items into correct categories', async () => {
    const items = ['展示会ブース制作', 'イベント企画', 'ノベルティ作成'];
    const result = await classifyItems(items, { categories: ['booth', 'event', 'promotion'] });
    assert.equal(result.length, 3);
    assert.equal(result[0].category, 'booth');
  });

  it('should handle empty list', async () => {
    const result = await classifyItems([], { categories: ['booth'] });
    assert.equal(result.length, 0);
  });

  it('should respect batch size limit', async () => {
    const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    const result = await classifyItems(items, { batchSize: 50 });
    assert.equal(result.length, 100);
  });

  it('should report errors per item without failing entire batch', async () => {
    const items = ['valid', '', 'valid'];
    const result = await classifyItems(items);
    assert.equal(result.results.length, 2);
    assert.equal(result.errors.length, 1);
  });
});
```

### テストカバレッジの基準

| レベル | 基準 | ツール数 |
|-------|------|---------|
| ✅ 最小 | 各ツールに正常系1 + エラー系1 | 全ツール |
| ✅ 標準 | 正常系・境界値・エラー系・空入力 | 全ツール |
| ✅ 完全 | 上記 + バッチ分割・レート制限・タイムアウト | 重要ツール |

---

## 4. Typed Units + Constrained Decoding でトークン節約

20Bモデルは8Kコンテキストという制約の下で、最大のパフォーマンスを引き出すには、**typed units**（型付き単位）と**constrained decoding**（制約付き復号）を組み合わせる。

### Typed Units とは

ツールの入出力を**厳密に型付けされた単位**で定義すること。自由文の代わりに構造化データを使うことで、LLMの出力を予測可能にし、トークン消費を削減する。

```javascript
// ❌ 型なし（トークン浪費）
const result = await llm.call(
  'Please analyze this keyword and tell me what category it belongs to, what the search volume is, and whether it is commercial or informational: ' + keyword
);
// 出力例: "The keyword '展示会ブース' is in the 'booth' category, has a high search volume, and is commercial in nature."
// トークン数: 〜30トークン

// ✅ 型付き（トークン節約）
const result = await llm.call(
  `Classify: ${keyword}\nFormat: {category:string, volume:number, intent:"commercial"|"informational"}`,
  { constrainedTo: 'json' }
);
// 出力例: {"category":"booth","volume":280000,"intent":"commercial"}
// トークン数: 〜15トークン（50%削減）
```

### Constrained Decoding の適用パターン

| 出力タイプ | 制約方法 | トークン節約効果 |
|-----------|---------|----------------|
| 分類ラベル | JSON Schema / Enum | 〜60% |
| yes/no判定 | 二値出力 | 〜70% |
| 数値範囲 | 数値フォーマット指定 | 〜50% |
| 構造化データ | JSON Schema | 〜50% |
| 自由文 | フォーマット指定なし | 0%（基準） |

### 実装例: 制約付き復号

```javascript
// const/option による出力制約
async function classifyWithConstrainedDecoding(items, categories, options = {}) {
  const response = await llm.call({
    messages: [
      { role: 'system', content: `You are a keyword classifier. Output raw JSON only.` },
      { role: 'user', content: `Classify each item into one of: ${categories.join(', ')}\nItems:\n${items.join('\n')}` }
    ],
    // Constrained decoding（モデルが対応している場合）
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'classification_result',
        schema: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  item: { type: 'string' },
                  category: { type: 'string', enum: categories },
                  confidence: { type: 'number', minimum: 0, maximum: 1 }
                },
                required: ['item', 'category']
              }
            }
          },
          required: ['results']
        }
      }
    }
  });
  return JSON.parse(response);
}
```

### トークン節約の複合効果

| 手法 | 単体効果 | 組み合わせ効果 |
|------|---------|---------------|
| リスト入力（ループ削減） | 〜90%（100件の場合） | 〜90% |
| Typed units | 〜50% | 〜50% |
| Constrained decoding | 〜50% | 〜50% |
| プロンプト圧縮 | 〜30% | 〜30% |
| **合計（掛け合わせ）** | | **〜97%** |

---

## 5. 20B/8Kコンテキストに合わせた設計

小〜中規模のモデル（20Bパラメータ、8Kトークンコンテキスト）をターゲットにする場合、設計に固有の制約が生まれる。

### 8Kコンテキストの配分

```text
┌──── 8,192 tokens ──────────────────────────────┐
│  system prompt:  1,000 tokens (12%)             │
│  tool definitions: 1,500 tokens (18%)           │
│  conversation history: 2,000 tokens (24%)       │
│  current input: 2,500 tokens (31%)              │
│  reserved for output: 1,192 tokens (15%)        │
└─────────────────────────────────────────────────┘
```

### 20Bモデル向け設計ガイドライン

| 原則 | 理由 | 実践 |
|------|------|------|
| **プロンプトは半分に** | 20Bモデルは70B+より指示の追随精度が低い | 指示は最小限に、例は1つだけ |
| **入力は前処理で圧縮** | 8Kに収めるために取捨選択が必要 | 不要な履歴は捨て、要約だけ渡す |
| **出力はJSON固定** | 自由文より構造化データのほうが正確 | Constrained decoding を必須に |
| **ツールは5個以内** | ツール定義が多すぎると判断が散る | 3〜5個のツールに絞る |
| **会話は3ターン以内** | 長期の履歴保持が苦手 | 各ターンで完結する設計 |

### コンテキスト管理のテクニック

```javascript
// 不要な履歴を捨てる（スライディングウィンドウ）
function prepareContext(systemPrompt, newInput, history, maxTokens = 6000) {
  const systemTokens = estimateTokens(systemPrompt);
  const inputTokens = estimateTokens(newInput);
  let available = maxTokens - systemTokens - inputTokens;
  
  // 履歴を新しい順に積み、収まらなければ古いものから捨てる
  let recentHistory = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(history[i]);
    if (tokens <= available) {
      recentHistory.unshift(history[i]);
      available -= tokens;
    } else {
      break; // 収まらない履歴は捨てる
    }
  }
  
  return { systemPrompt, history: recentHistory, input: newInput };
}
```

---

## 6. Human-in-the-loop の明確な定義

AIエージェントが完全自律で動く領域と、人間の判断が必要な領域を**明確に線引き**する。この線引きがあいまいだと、エージェントが判断すべきでないことを判断して事故を起こすか、逆に人間が確認すべきでない細部まで確認して効率が落ちる。

### 判断の3区分

```text
区分A: エージェントが自律判断
  ┃  ← ライン1
  ↓
区分B: エージェントが判断→結果を報告
  ┃  ← ライン2
  ↓
区分C: 人間の承認が必要
```

### 各区分の具体例

| 区分 | 判断内容 | エージェントの行動 | 人間の負荷 |
|------|---------|-------------------|-----------|
| **A** | ツールの呼び出し順序、バッチサイズ、リトライ戦略 | 自律実行、結果をログに記録 | ゼロ（障害時のみ通知） |
| **B** | 分類結果のしきい値調整、処理対象の優先順位 | 自律実行＋結果の要約を報告 | 確認のみ（是正指示は任意） |
| **C** | 社外への送信、契約条件の変更、削除操作 | 判断材料を提示し、内容を承認待ちに | 全文確認＋YES/NOの判断 |

### ライン1（A/B境界）の設計基準

以下の条件をすべて満たす場合、エージェントが自律判断してよい：

1. **取消し可能である**: エージェントの判断を後から取り消せる（git reset、APIの取り消し、ドラフト保存）
2. **影響範囲が限定的である**: 1回の判断が他のシステムや人間に影響しない
3. **失敗のコストが低い**: 間違えても再実行すれば済む（トークン消費程度）
4. **過去の実績がある**: 同じ種類の判断を過去に10回以上成功している

### ライン2（B/C境界）の設計基準

以下のいずれかを満たす場合、人間の承認を必須とする：

1. **取消し不能である**: 送信済みメール、公開済みコンテンツ、削除済みデータ
2. **金銭的コストが発生する**: 有料APIの呼び出し、課金プランの変更、発注
3. **法的拘束力がある**: 契約、同意、利用規約の変更
4. **外部に公開される**: SNS投稿、ブログ公開、顧客への連絡
5. **初めての判断である**: 類似の判断を過去に行ったことがない

### Human-in-the-loop の実装パターン

```javascript
// ライン1（A/B境界）の実装: 自律判断＋報告
async function autoClassify(items) {
  const result = await classifyItems(items, { autoThreshold: 0.7 });
  await logToLedger({
    action: 'auto_classify',
    inputCount: items.length,
    outputCount: result.length,
    verdict: 'auto' // 人間の確認不要
  });
  return result;
}

// ライン2（B/C境界）の実装: 保留＋承認待ち
async function sendProposal(proposal) {
  const draft = await createDraft(proposal);
  await holdForApproval({
    type: 'external_send',
    content: draft,
    approver: 'kim@orgiast.jp',
    deadline: '2026-11-12T10:00:00Z',
    reminderInterval: '6h'
  });
  // 承認されるまで待機（ポーリング or webhook）
  const approved = await waitForApproval(draft.id);
  if (!approved) {
    await logToLedger({ action: 'send_proposal', verdict: 'rejected' });
    return { status: 'rejected', reason: approved.reason };
  }
  const result = await sendEmail(draft);
  await logToLedger({ action: 'send_proposal', verdict: 'approved', result });
  return result;
}
```

### 承認フローの設計

```text
エージェント
  │ 「以下の社外送信の承認をお願いします」
  │ 【内容全文】
  │ 【承認期限: YYYY-MM-DD HH:MM】
  │ YES / NO（理由付き）
  ▼
人間（kim）
  │ YES → エージェントが実行、結果を報告
  │ NO  → 修正理由を添えてエージェントに差し戻し
  ▼
エージェント
  │ YES → 実行結果を証拠台帳に記録
  │ NO  → 修正して再提案 or 終了
```

### 注意点

- **承認を「確認してYESを押すだけ」にしない**: 人間が内容を読まずに承認する習慣がつくと、安全機構として機能しなくなる。承認依頼には常に変更のサマリと影響範囲を含める
- **判断の保留は期限付きで**: 無期限の保留はタスクを停滞させる。期限を過ぎたらエスカレーションする
- **判断履歴を蓄積する**: 同じ種類の判断を繰り返し人間に求めない。過去の判断パターンを学習してライン1/2の境界を広げる

---

## 7. オージャストのブース自動化エージェントへの適用

以上の原則を、オージャストのブース関連自動化エージェントに具体的に適用する。

### 対象エージェント

| エージェント | 説明 | 現在の状態 |
|------------|------|-----------|
| キーワードリサーチ | SEOキーワードの調査・分類・優先順位付け | ✅ 実装済み（X-0013 SEO補完） |
| 出展者募集 | 展示会の出展者をリストアップし、打診メールを生成 | 🔄 開発中 |
| 見積生成 | ブース制作の見積を自動生成 | 📋 設計中 |
| 在庫管理 | 備品在庫の自動発注・補充 | 📋 設計中 |

### 適用マッピング

```text
原則1: ツール文書化
  ┃  docs/agent-tools/ に各ツールのmarkdownを配置
  ┃  ✅ classify-items.md（既存）
  ┃  🔄 send-email.md（作成中）
  ┃  📋 estimate-generator.md（未着手）
  ▼
原則2: リスト入力＋ループ回避
  ┃  ✅ classifyItems(tems[]) — バッチ対応済み
  ┃  🔄 sendEmails(recipients[]) — 一括送信対応
  ┃  📋 estimateMultiple(items[]) — 未対応
  ▼
原則3: テストファースト
  ┃  ✅ tools/classify-items.test.mjs — 6 tests
  ┃  🔄 tools/send-email.test.mjs — 準備中
  ▼
原則4: Typed units + Constrained decoding
  ┃  ✅ 分類結果をJSONスキーマで定義
  ┃  🔄 出力フォーマットを全ツールで統一
  ▼
原則5: 20B/8Kコンテキスト対応
  ┃  ✅ ツール定義を5個以内に制限
  ┃  🔄 コンテキストウィンドウの明示的管理
  ▼
原則6: Human-in-the-loop
  ┃  ✅ 社外送信はライン2（kim承認必須）
  ┃  🔄 承認期限とエスカレーションの設定
```

### 実装優先順位

| 優先度 | タスク | 期待効果 | 工数見積 |
|-------|-------|---------|---------|
| P0 | 全ツールをリスト入力対応に修正 | ループ削減によるトークン90%削減 | 2時間 |
| P0 | 全ツールのユニットテストを追加 | バグの早期発見、再現性確保 | 3時間 |
| P1 | ツール文書を `docs/agent-tools/` に整備 | 再利用性向上、属人性排除 | 1時間 |
| P1 | Constrained decoding の導入 | 出力の安定化、トークン50%削減 | 2時間 |
| P2 | Human-in-the-loop ライン定義の文書化 | 安全な自律運用の基盤 | 1時間 |
| P2 | コンテキスト管理の共通化 | 20B/8Kモデルでの安定動作 | 2時間 |

---

## 8. まとめ

エージェント構築の再現手順（5原則＋Human-in-the-loop）は、以下の4点を同時に達成する:

1. **再現性**: ツールの文書化とリスト入力設計により、誰が・どのAIが実装しても同じ結果が得られる
2. **検証容易性**: ツール→エージェントの順のテストにより、バグの切り分けが一意に特定できる
3. **トークン効率**: Typed units + constrained decoding で出力トークンを50〜70%削減する
4. **安全な自律運用**: Human-in-the-loop の明確な線引きにより、人間の負荷を最小限にしながら取消し不能な操作を防ぐ

オージャストのブース関連自動化エージェント（キーワードリサーチ・出展者募集・見積生成・在庫管理）に本手順を適用することで、各エージェントの開発・検証・運用を再現可能にし、人的負荷を最小化する。

### 期待効果

| 指標 | 現状 | 目標（適用後） |
|------|------|---------------|
| 新規エージェントの開発工数 | 5〜10日 | 2〜3日（テンプレート＋再利用） |
| バグの切り分け時間 | 2〜4時間 | 15分以内（テスト層で特定） |
| トークン消費（100件処理） | 10,000〜20,000 | 1,000〜3,000（バッチ＋制約復号） |
| 人間の承認負荷 | 都度確認 | ライン2の判断のみ（月数件） |
| 他メンバーへの引き継ぎ工数 | 1日 | 30分（文書＋テストで完結） |