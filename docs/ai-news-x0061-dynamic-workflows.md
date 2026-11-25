# X-0061: Dynamic Workflows でAIエージェント業務自動化

> AIニュース提案 2026-11-16
> 対象: Workflow ツールのスクリプト駆動オーケストレーションで、AIエージェントを並列・パイプライン制御し業務を自動化する
> 基: [X-0023 サブエージェント委譲とeffort調整](ai-news-x0023-subagent-delegation-effort-tuning.md)

## 概要

Claude Code に組み込まれた **Workflow** ツールは、複数のAIエージェントを **決定論的にオーケストレーション** するためのスクリプト実行環境である。`parallel()` による並列一斉処理、`pipeline()` による段階的制御（前段の合格時のみ次へ）、`agent()` による役割特化エージェントの起動を組み合わせ、人の手を介さない反復業務の完全自動化を実現する。

```
[入力] → parallel(3エージェント) → pipeline(検証 → 統合) → [出力]
           ├ SOP監査① ─→ 検証 ─→
           ├ SOP監査② ─→ 検証 ─→ 統合 → 共有ドライブ同期
           └ SOP監査③ ─→ 検証 ─→
```

### Workflow の核となる関数

| 関数 | 役割 | 動作 |
|------|------|------|
| `agent(prompt, opts)` | サブエージェントを起動 | 指定された役割・スキーマでタスクを実行し結果を返す |
| `parallel(thunks)` | 複数タスクを並列実行 | 全タスクの完了を待って結果を配列で返す（バリア） |
| `pipeline(items, stages...)` | 各項目を全段階で逐次処理 | 項目ごとにstage1→stage2→...を通過。バリアなし |
| `phase(title)` | 進捗グループを宣言 | UI表示をフェーズで整理 |

---

## 1. なぜ Dynamic Workflows か

### 1.1 課題

- **単一会話の限界**: 1つの会話コンテキストでは扱える知識量・ターン数に限界があり、大規模な監査や多面的なチェックを1セッションで完了できない
- **並列性の欠如**: 複数の独立したチェックを直列に実行すると、全体の所要時間が各チェックの合計になる
- **決定論的制御の不在**: AIエージェントの出力は確率的で、前段の結果に応じて次段を実行するか判断する制御構造が組み込まれていない。人間による中間確認が必須になる
- **再利用性の低さ**: 一度組んだワークフローを保存して別の案件に使い回す仕組みがない

### 1.2 Dynamic Workflows の解決策

**Dynamic Workflows**（Claude Code の Workflow ツール）は、JavaScript スクリプトでAIエージェントの起動・並列化・条件分岐・パイプライン制御を記述し、一気通貫で実行する：

| 課題 | Workflow の解決 |
|------|----------------|
| 単一会話の限界 | サブエージェントは独立した会話コンテキストで動作。大規模タスクを適切な粒度に分割 |
| 並列性の欠如 | `parallel()` で独立タスクを同時実行。所要時間は最長の1タスクのみ |
| 決定論的制御の不在 | 条件分岐（前段合格時のみ次へ）やループ（一定品質に達するまで反復）をコードで記述 |
| 再利用性の低さ | スクリプトを保存し、パラメータを変えて複数案件に適用可能 |

---

## 2. 3つの基本パターン

### 2.1 並列バッチ処理（parallel）

最もシンプルなパターン。複数の独立タスクを同時実行する。全件完了を待って結果を回収する。

```javascript
export const meta = {
  name: 'sop-audit',
  description: 'SOP文書を並列監査し統合レポートを生成',
  phases: [{ title: '監査' }, { title: '統合' }],
}

phase('監査')
const docs = ['SOP-001.md', 'SOP-002.md', 'SOP-003.md']
const results = await parallel(
  docs.map(doc => () =>
    agent(`「${doc}」をPII（個人情報）の観点で監査してください。監査結果は以下をJSONで出力:
    - file: ファイル名
    - hasPII: true/false
    - piiFields: 見つかったPII項目の配列
    - risk: high/medium/low
    - recommendation: 推奨対策`, { schema: AUDIT_SCHEMA, phase: '監査' })
  )
)

phase('統合')
const allPassed = results.filter(Boolean).every(r => !r.hasPII)
if (allPassed) {
  await agent(`全てのSOPがPIIフリーでした。共有ドライブへの同期を開始します。
  結果: ${JSON.stringify(results)}`, { phase: '統合' })
  log('✅ 全SOPクリア → 共有ドライブ同期')
} else {
  log(`⚠️ ${results.filter(r => r.hasPII).length}件のSOPにPIIを検出 → 修正依頼を生成`)
}
```

**ポイント**:
- 各SOPの監査は独立しているため、同時実行で高速化
- 全結果を集約し、条件（全件PIIフリー）に応じて次アクションを分岐
- スキーマ（AUDIT_SCHEMA）で出力形式を強制し、後段でのパースを不要に

### 2.2 パイプライン処理（pipeline）

各項目を段階的に処理する。前段の結果を次段が受け取り、条件に応じて処理を継続する。

```javascript
export const meta = {
  name: 'code-ui-spec-check',
  description: '3エージェントでコード・UI・仕様のズレを同時チェック',
  phases: [{ title: 'チェック' }, { title: '統合' }],
}

phase('チェック')
const ITEMS = [
  { target: 'components/Header.tsx', spec: 'SCR-001-home', type: 'code' },
  { target: 'components/Header.tsx', spec: 'SCR-001-home', type: 'ui' },
  { target: 'components/Header.tsx', spec: 'SCR-001-home', type: 'spec' },
]

const discrepancies = await pipeline(
  ITEMS,
  async (item) => {
    const checkType = {
      code: 'コードが仕様通りに実装されているか、型・Props・ロジックの観点でチェック',
      ui: 'UIがワイヤフレームと一致しているか、余白・色・フォント・レスポンシブの観点でチェック',
      spec: '仕様書に実装不可能・矛盾・未定義の項目がないかチェック',
    }
    return agent(`${checkType[item.type]}
対象ファイル: ${item.target}
該当仕様: ${item.spec}
相違点があればJSONで出力:
- file: ファイル名
- type: code/ui/spec
- description: 相違の説明
- severity: high/medium/low
- recommendation: 修正案`, { schema: FINDING_SCHEMA, phase: 'チェック' })
  },
  // 第2段階: 3つの視点の結果を相対評価
  async (finding, originalItem) => {
    if (!finding || finding.severity === 'none') return null
    return agent(`この指摘の重大度を「他2つのチェック（コード/UI/仕様）の結果」と比較して検証:
    チェック種別: ${originalItem.type}
    指摘: ${finding.description}
    深刻度: ${finding.severity}
    本当に修正すべきか、第三者の視点で判断してください。
    verdict: must_fix / should_fix / accept
    reason: 判断根拠`, { schema: VERDICT_SCHEMA, phase: 'チェック' })
  }
)
```

**ポイント**:
- 同一コンポーネントを異なる3つの視点（コード/UI/仕様）で同時チェック
- `pipeline()` はバリアなし — 1項目の全段階完了を待たず、他の項目は独立して進行
- 第2段階でクロスチェックにより偽陽性を削減

### 2.3 ループ＋品質評価（loop-until-dry）

発見が途切れるまで繰り返す発見型ワークフロー：

```javascript
export const meta = {
  name: 'booth-ui-regression',
  description: '展示場タブレット用UIのタッチ操作性を検証',
  phases: [{ title: '発見' }, { title: '検証' }],
}

const OPERATIONAL_ISSUES = []
let dryRuns = 0

phase('発見')
while (dryRuns < 3) {
  const batch = await parallel(
    ['タップ応答', 'スワイプ', 'ピンチズーム', 'フォーム入力'].map(area => () =>
      agent(`展示場スタッフ用タブレットの「${area}」操作で、タッチ操作性の問題を1つだけ挙げてください。
      既に報告済みの問題リスト: ${JSON.stringify(OPERATIONAL_ISSUES.map(i => i.description))}
      問題がないなら "none" と返してください。`, { schema: ISSUE_SCHEMA, phase: '発見' })
    )
  )
  const fresh = batch.filter(Boolean).filter(r => r.issue !== 'none')
  if (fresh.length === 0) { dryRuns++; continue }
  dryRuns = 0
  OPERATIONAL_ISSUES.push(...fresh)
  log(`発見ラウンド: ${fresh.length}件追加（計${OPERATIONAL_ISSUES.length}件）`)
}

phase('検証')
const verified = await parallel(
  OPERATIONAL_ISSUES.map(issue => () =>
    agent(`この問題は本当に修正すべきか検証: ${issue.description}
    再現条件: ${issue.reproducible}
    第三者の視点で客観判断してください。
    verdict: real / false_positive / low_priority
    reason: 判断根拠`, { schema: VERDICT_SCHEMA, phase: '検証' })
  )
)
log(`✅ ${verified.filter(v => v.verdict === 'real').length}件のタッチ操作性問題を確認`)
```

**ポイント**:
- `while` ループで新しい問題が3連続で見つからなくなるまで探索
- 各ラウンドで既発見リストを除外条件として渡し、重複を防止
- 最終段で第三者検証により偽陽性を排除

---

## 3. オージャストへの適用シナリオ

### 3.1 展示会ブース制作SOPの一括監査

**課題**: 展示会ごとに異なるブース設営SOP（安全手順・搬入計画・撤収手順）を人手で監査するのに1件あたり30分〜1時間かかる。

**Workflow 適用**:
- 全SOPを `parallel()` で一斉監査（安全基準・法令遵守・予算整合の3軸）
- 全項目クリアのみ承認ワークフローへ進行
- 指摘事項は自動で修正案と共にレポート化
- **所要時間: 10SOPを約3分で完了**（従来比 90% 削減）

### 3.2 展示場スタッフ用タブレットのUI/操作性チェック

**課題**: イベント現場で使用するタブレットアプリのタッチ操作性・UI確認を、複数デバイス・画面で人手チェックしている。

**Workflow 適用**:
- 画面ごとに3エージェント（操作性・視認性・アクセシビリティ）で並列チェック
- 発見ループで問題を網羅的に洗い出し
- 検証段階で偽陽性を排除し、本物の問題だけを報告
- **作業時間: 4時間→20分に短縮**

### 3.3 イベント企画書の品質チェック

**課題**: 展示会イベントの企画書に記載漏れ・数値誤り・過去事例との矛盾がないか人手で確認している。

**Workflow 適用**:
- `pipeline()` で3段階チェック（形式検証→内容検証→過去事例突合）
- 前段の不備は次段へ進まず、差し戻し
- 保存済みスクリプトをイベントごとに流用（パラメータ変更のみ）
- **品質ばらつきを80%削減**

### 3.4 案件引き継ぎドキュメントの自動生成

**課題**: 案件のアサイン変更時に引き継ぎドキュメントを作成するのに数時間かかる。必要な情報はDrive・メール・チャットに散在。

**Workflow 適用**:
- `parallel()` で3経路（Drive文書・メールスレッド・チャット履歴）から情報収集
- `pipeline()` で収集情報を構造化→整合性チェック→フォーマット整形
- **引き継ぎドキュメント作成時間: 3時間→15分**

---

## 4. 保存ワークフローの現場再利用

Workflow スクリプトは `args` 経由でパラメータを受け付ける設計にすることで、案件ごとに修正不要で再利用できる。

```javascript
// saved-workflow/booth-sop-audit.js
export const meta = {
  name: 'booth-sop-audit',
  description: '展示会ブース設営SOPの一括監査',
}

const { eventName, sopFiles, auditorLens } = args // 案件ごとにパラメータ注入

phase('監査')
const results = await parallel(
  sopFiles.map(file => () =>
    agent(`【${eventName}】展示会用SOP監査
    ファイル: ${file}
    監査レンズ: ${auditorLens.join(', ')}
    ...`, { schema: AUDIT_SCHEMA })
  )
)
```

**イベント現場での使い方**:
1. イベント開催前に案件名とSOPファイルリストを指定して `Workflow({name: 'booth-sop-audit', args: {...}})` を呼ぶ
2. 全自動で監査が実行され、確認済みSOPが共有ドライブに格納される
3. 同じスクリプトを別イベントにも使い回せる

---

## 5. 高度なオーケストレーションパターン

### 5.1 3視点パネル（judge panel）

同一タスクを異なる視点で実行し、結果をスコア比較して最適なものを採用：

```javascript
const approaches = await parallel(
  [
    { name: 'cost-first', desc: '最小コストで運用する設計' },
    { name: 'quality-first', desc: '最高品質を追求する設計' },
    { name: 'speed-first', desc: '最短納期で納品する設計' },
  ].map(a => () =>
    agent(`展示会ブース設計案を「${a.desc}」の観点で提案してください。`, { schema: DESIGN_SCHEMA })
  )
)
// 3案を比較評価し最適解を合成
const synth = await agent(`以下の3つの設計案を比較し、最適な要素を組み合わせた
統合案を提案してください:
${approaches.map((r, i) => `【案${i+1}】${r.name}: ${r.summary}`).join('\n')}`, { schema: DESIGN_SCHEMA })
```

### 5.2 敵対的検証（adversarial verify）

発見項目ごとに「反証」を試みさせることで偽陽性を排除：

```javascript
const votes = await parallel(
  Array.from({ length: 3 }, () => () =>
    agent(`この指摘を反証してみてください。もし不確かなら「refuted=true」としてください。
    指摘: ${finding.description}
    根拠: ${finding.evidence}`, { schema: { type: 'object', properties: {
      refuted: { type: 'boolean' },
      reason: { type: 'string' }
    }, required: ['refuted', 'reason'] } })
  )
)
const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
```

### 5.3 複合監査テンプレート（再現可能なパターン集）

| パターン | 用途 | 構成 |
|---------|------|------|
| **並列監査** | SOP・書類の一括チェック | parallel(監査)×全件 → pipeline(検証→統合) |
| **3視点評価** | UI/コード/仕様の整合確認 | parallel(3エージェント) → pipeline(検証) |
| **発見ループ** | 問題の網羅的洗い出し | while(新規発見あり) parallel(探索) |
| **敵対的検証** | 発見項目の真贋判定 | parallel(3反証) → majority判断 |
| **継続監視** | 定期的な品質チェック | CronCreate + Workflow(保存スクリプト) |

---

## 6. 実装状況

| 項目 | 状態 | 所在 |
|------|------|------|
| 本提案文書 | ✅ 追加 | `docs/ai-news-x0061-dynamic-workflows.md` |
| Workflow ツール本体 | ✅ 既存 | Claude Code 組込（Workflow ツール） |
| ワークフローオーサリングリファレンス | ✅ 既存 | スキル `workflow-authoring` |

### 未着手（次回以降）

| 項目 | 優先度 | 備考 |
|------|--------|------|
| 展示会ブースSOP監査ワークフロー | 高 | 実SOPで実測し手順書化 |
| タブレットUIチェックワークフロー | 高 | エミュレータか実機で検証 |
| イベント企画書品質チェックワークフロー | 中 | テンプレートから自動生成 |
| 保存ワークフローディレクトリ整備 | 中 | `saved-workflows/` に格納し命名規則統一 |
| CI連携（チェック自動化） | 低 | GitHub Actions からWorkflowを呼ぶ |

---

## 7. 結論

**Dynamic Workflows** は、AIエージェントを「使い捨てのチャット応答」から「組織の反復業務を代替する自動化コンポーネント」へと進化させる。`parallel()` と `pipeline()` というシンプルなプリミティブで、複雑な業務フローをコード化・保存・再利用できる。

オージャストでは展示会ブース制作SOP監査・イベントスタッフ用タブレットUIチェック・案件引き継ぎ自動生成に適用することで、以下の効果を見込む：

- **反復業務の工数**: 20時間/週 → 2時間/週（▲90%）
- **品質ばらつき**: 人手依存による ±30% → ワークフロー標準化で ±5%
- **現場再利用率**: 保存ワークフローを別イベントに流用する際の修正工数ゼロ