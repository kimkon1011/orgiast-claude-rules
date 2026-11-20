# X-0026: モデルルーターで品質あたりコスト8.82倍 — ブースデザイン生成ベンチマーク

## 概要
展示会ブースデザイン生成タスクの再現可能なベンチマークを作成し、複数モデルの品質/コスト比を計測する。X-0010 の model-router.mjs を拡張し、ブースデザインに特化したタスクセットと品質評価基準を追加する。

## 既存資産（編集禁止）
- `tools/model-router.mjs` — 一般ルーター（ROUTING_TABLE, classifyTask, routeTask, estimateCost, loadTest）
- `tools/model-router.test.mjs` — 既存テスト
- `tools/provider-routing.mjs` — gatewayModel / routeCandidate

## 新規作成ファイル

### 1. tools/booth-design-bench.mjs

既存 model-router.mjs の ROUTING_TABLE・classifyTask・estimateCost・loadTest を import して拡張する。

**BOOTH_DESIGN_TASKS**（以下を Object.freeze した配列）:

各タスクは `{ id, title, text, category, qualityCriteria, minTokens, maxTokens }`:
| id | title | category | text（日本語プロンプト） |
|----|-------|----------|------------------------|
| bd-01 | ブース基本企画案 | planning | 展示会ブースの基本企画案を作成してください。ターゲット来場者、伝えたいメッセージ、ブースの性格（プレゼン型/体験型/商談型）を含めて、A4 1枚程度にまとめてください。 |
| bd-02 | デザインコンセプト作成 | design | モダンで開放的、かつ来場者が自然と立ち寄りたくなるブースデザインのコンセプトを提案してください。使用する色彩（2〜3色）、素材感、照明計画を含めて記述してください。 |
| bd-03 | レイアウト図作成指示 | layout | 3m×3mの小間ブースのレイアウトを設計してください。カウンター、パネル、展示什器、来場者動線を考慮し、東西からの見え方も考慮してください。 |
| bd-04 | キャッチコピー生成 | copy | 展示会ブース「環境ソリューションEXPO」向けのキャッチコピーを5案作成してください。サブコピーも各1行添えてください。ターゲットは製造業の環境担当者です。 |
| bd-05 | 展示品リスト作成 | listing | 半導体製造装置展示ブースに適した展示品リストを10項目作成してください。各項目に展示の目的と想定される来場者メリットを1行ずつ付けてください。 |
| bd-06 | 配色提案 | design | IT企業向け展示ブースの配色を3案提案してください。企業イメージ（青系・テクノロジー）を維持しつつ、展示会場内で目立つ組み合わせを選んでください。各案に使用割合（%）を付けてください。 |
| bd-07 | 施工指示書作成 | construction | 3間×3間の島ブースの施工指示書を作成してください。壁面パネル、床材、照明、電気配線の仕様を箇条書きで列挙し、施工順序も記載してください。 |
| bd-08 | 来場者ターゲット分析 | research | 環境展示会に来場する想定来場者層を分析し、3つのペルソナを作成してください。各ペルソナに役職、関心事項、ブースで見たい情報、行動パターンを含めてください。 |
| bd-09 | 予算案作成 | budget | 3日間の展示会ブース（施工・運営・撤去込み）の予算案を項目別に作成してください。想定規模は小間9小間、予算上限300万円です。 |
| bd-10 | タイムライン作成 | planning | 展示会出展決定から本番までのタイムラインを週単位で作成してください。標準スケジュールは出展決定から3ヶ月前とし、各工程のリードタイムと担当者を明示してください。 |
| bd-11 | 競合ブース調査分析 | research | 同日程で開催される競合展示会の出展企業リストを分析し、当社ブースの差別化ポイントを3つ提案してください。各差別化ポイントに実装方法を併記してください。 |
| bd-12 | スタッフ接遇マニュアル作成 | operation | 展示会ブースのスタッフ向け接遇マニュアルを作成してください。来場者への声かけ方法、商談の進め方、名刺交換の注意点、1日のタイムスケジュールを含めてください。 |
| bd-13 | デジタル活用施策 | technology | ブースでのデジタル技術活用施策を5案提案してください。タブレット/サイネージ/AR/VR/QRコードの中から選択し、各施策の導入コスト（概算）と期待効果を記載してください。 |
| bd-14 | ブース評価基準作成 | evaluation | 展示会終了後のブース成果を評価するためのKPIと評価基準を作成してください。定量指標（リード獲得数等）と定性指標（ブランド認知等）の両方を含めてください。 |
| bd-15 | 誘導サイン計画 | signage | 展示会場内で自社ブースへ来場者を誘導するサイン計画を作成してください。入口からの導線、主要交差点でのサイン、ブース前面での訴求ポイントを含めてください。 |

**品質評価基準（qualityCriteria）** — 各タスクに以下の構造で評価基準を添える:
```js
{
  criteria: ['網羅性（必須要素の過不足）', '具体性（数値・固有名詞の有無）', '実用性（そのまま実務に使えるか）', '独自性（テンプレート回答との差）'],
  maxScore: 10,
  scoringGuide: {
    coverage: '必須要素が全て含まれていれば高い。不足1要素につき-2点。',
    specificity: '数値・固有名詞・具体的な事例があるほど高い。抽象的な記述のみで-3点。',
    practicality: 'そのまま顧客に提示できる完成度。ポンチ絵レベルで-3点。',
    originality: '汎用テンプレートでない独自の視点や提案があるか。テンプレート感が強いと-3点。',
  }
}
```

**コスト見積もり関数:**
- `estimateBoothCost(taskId, route)` — タスクのminTokens/maxTokensを使って estimateCost を呼ぶ
- 入力トークン = maxTokens（安全側）, 出力トークン = タスクタイプ別想定（planning: 1500, design: 2000, copy: 500, listing: 1500, construction: 2000, research: 1500, budget: 1500, operation: 1500, technology: 1500, evaluation: 1000, signage: 1500）

**品質スコア模擬（fixture）:**
`BOOTH_QUALITY_FIXTURES` を Object.freeze したテーブル:
```js
{
  "deepseek/deepseek-v4-flash": {
    "bd-01": 6.5, "bd-02": 5.5, "bd-03": 5.0, "bd-04": 7.5, "bd-05": 8.0,
    "bd-06": 6.0, "bd-07": 4.5, "bd-08": 7.0, "bd-09": 6.5, "bd-10": 7.5,
    "bd-11": 6.0, "bd-12": 7.5, "bd-13": 5.5, "bd-14": 7.0, "bd-15": 5.5
  },
  "moonshotai/kimi-k3": {
    "bd-01": 7.5, "bd-02": 7.0, "bd-03": 6.5, "bd-04": 8.0, "bd-05": 8.5,
    "bd-06": 7.0, "bd-07": 6.0, "bd-08": 8.0, "bd-09": 7.5, "bd-10": 8.0,
    "bd-11": 7.0, "bd-12": 8.0, "bd-13": 7.0, "bd-14": 7.5, "bd-15": 6.5
  },
  "openai/gpt-4o": {
    "bd-01": 8.5, "bd-02": 8.5, "bd-03": 8.0, "bd-04": 9.0, "bd-05": 9.0,
    "bd-06": 8.5, "bd-07": 8.0, "bd-08": 9.0, "bd-09": 8.5, "bd-10": 8.5,
    "bd-11": 8.5, "bd-12": 8.5, "bd-13": 8.0, "bd-14": 8.5, "bd-15": 8.0
  }
}
```

**これらのスコアは以下の前提に基づく模擬値（specification fixture）:**
- deepseek/deepseek-v4-flash: 高速だが創造的/構造的タスクで品質が落ちる。定型・リスト作成に強い。
- moonshotai/kimi-k3: バランス型。企画・コピー・分析で良好な品質。
- openai/gpt-4o: 全タスクで高品質だがコストが約8.82倍（入力単価ベース: $2.50 vs $0.15）。

**主要関数:**

1. `boothBenchmark(options)` — 全タスク×全モデルの品質/コスト/品質コスト比を計算
   - 戻り値: `{ results, summary }`
   - results: `[{ taskId, title, category, model, qualityScore, costUsd, costPerQuality, inputTokens, outputTokens }]`
   - summary: `{ models: { [model]: { avgQuality, totalCost, avgCostPerQuality } }, bestPerCategory, recommendedRouting }`

2. `recommendedRouting(results)` — qualityScore差が0.5以内かつ安いモデルへルーティング
   - 各タスクについてgpt-4oとdeepseek/kimiの品質スコア差を比較
   - 差が0.5以内なら安価モデルを推奨
   - 戻り値: `{ [taskId]: { recommendedModel, originalModel, qualityDiff, costSaving, routingDecision } }`
   - routingDecision: 'same_quality_cheaper' | 'quality_premium' | 'other'

3. `boothBenchmarkMarkdown()` — 結果をMarkdown表で出力
   - 品質順位表、コスト順位表、品質コスト比順位表
   - 推奨ルーティング表
   - 総合サマリ（品質あたりコスト比、節約率）

4. ルーティング分類の拡張: `classifyBoothTask(text)`
   - 既存 classifyTask を呼び、ブースデザイン関連キーワード（企画/レイアウト/デザイン/予算/コピー/施工等）を含むタスクを検出
   - ブース関連と判定されたタスクは medium〜complex にマッピング

**CLI:**
```
node tools/booth-design-bench.mjs benchmark [--out <file.md>]
node tools/booth-design-bench.mjs routing [--out <file.md>]
node tools/booth-design-bench.mjs quality [--model openai/gpt-4o] [--out <file.md>]
```

### 2. tools/booth-design-bench.test.mjs

node:test + assert/strict のテスト。以下のテストケース:
1. BOOTH_DESIGN_TASKS が15件・全要素に required fields
2. boothBenchmark が全タスク×全モデルの結果を返す（results が 15×3=45 件）
3. qualityScore が deepseek < kimi < gpt-4o の順（fixture前提）
4. costPerQuality で deepseek が最安
5. recommendedRouting が same_quality_cheaper を適切に判定
6. recommendedRouting の節約率が50%以上（品質差0.5未満のタスクをdeepseek/kimiに振り分けた場合）
7. classifyBoothTask がブース関連キーワードを含むテキストを正しく検出
8. CLI benchmark が Markdown を出力
9. 品質あたりコスト比が大体8.82倍（gpt-4o/deepseekの入力単価比）に近いことを確認

### 3. docs/x0026-booth-design-bench.md — ベンチマークレポート

以下のテンプレートに従い Markdown レポートを生成。CLI の benchmark コマンドで自動生成される内容を含む。

## 禁止事項
- 既存の tools/*.mjs / tools/*.test.mjs を書き換えない
- Claude API（anthropic）は使わない
- model-router.mjs の定数（ROUTING_TABLE, BENCHMARK_TASKS）を変更しない
- 外部サービスへの自動送信・デプロイを行わない
- 実APIを呼ぶコードを含めない（すべてdry-run/simulation/fixture）

## 検証
```
node --test tools/booth-design-bench.test.mjs
node tools/booth-design-bench.mjs benchmark
```

## このファイルを編集しない
このファイルは実装指示書であり、Codex が読み取り専用で参照する。編集しないこと。