# X-0069: AgentRunでトークン消費削減

## 概要

**出典**: @codexneo4 (https://x.com/i/web/status/2122225656977146193)  
**提案**: 過去解決問題を経験蓄積、成功手順をSkills化、繰り返しをWorkflow化してトークン消費削減  
**ステータス**: ✅ 実装完了（PR #XXXX）

---

## 1. AgentRun OSS の概念

AgentRun OSS は「エージェントが過去に解決した問題を経験として蓄積し、同じ種類の作業を毎回ゼロから調べ直さない」というアプローチ。具体的には：

| レイヤー | 手段 | 効果 |
|---|---|---|
| 経験蓄積 | 成功手順を Skills として保存 | 再現性の確保、検証済みパターンの再利用 |
| 反復排除 | 繰り返し作業を Workflow 化 | 毎回のトークン消費削減、品質の均一化 |
| ナレッジ共有 | Skills・Workflow を全セッションで利用可能に | 組織全体の生産性向上 |

---

## 2. トークン削減効果

毎回の「調査→設計→実装→レビュー」サイクルを Skills 化・Workflow 化することで削減できるトークン量：

| 工程 | 1回あたり削減トークン（概算） | 年N回での削減率 |
|---|---|---|
| 事前調査（要件・パターン） | 8K〜15K 入力トークン | 約60〜80%削減 |
| 設計判断（過去の決定参照） | 10K〜20K 入力トークン | 手順書参照で約70%削減 |
| 実装テンプレート | 5K〜10K 出力トークン | テンプレ適用で約50%削減 |
| レビュー指摘 | 3K〜5K 出力トークン | Skillによる事前品質で約40%削減 |

**合計**: 1回あたり約26K〜50Kトークン削減。年20回の類似作業で約520K〜1Mトークンの節約。

---

## 3. 実装パイプライン: 成功事例 → Skill → Workflow

```
過去の成功事例（レコード・コード・手順）
        ↓
  ① パターン抽出（何が成功要因か）
        ↓
  ② Skill化（検証済み手順を SKILL.md に）
        ↓
  ③ Workflow化（複数工程を自動連鎖）
        ↓
  ④ 全セッション配布（知識の共有）
```

### 3.1 ステップ①: 成功パターンの特定

- 対象: 過去のブース制作プロジェクト・コード実装・顧客対応
- 抽出項目:
  - 作業の種類（見積・デザイン・施工管理・記事作成）
  - 使用したツール・コマンド
  - 決定した判断基準
  - 発生した問題とその解決策

### 3.2 ステップ②: Skills 化（SKILL.md 形式）

現在のリポジトリにある Skills 例:
- `skills/booth-kw-research/` — キーワードリサーチの4Phase
- `skills/rebooth-customer-interview/` — インタビュー記事作成
- `skills/deploy-verify/` — デプロイ検証

SKILL.md の基本構造:
```markdown
---
name: <short-name>
description: <1行の説明>
---

# タイトル

## 目的
このSkillが解決する問題、使うべき場面

## トリガー
- 起動条件（スラッシュコマンド・キーワード）

## 手順
1. ステップ1
2. ステップ2
...

## 使用条件・制約
## 出力・成果物
## 改善サイクル
```

### 3.3 ステップ③: Workflow 化

繰り返し作業を `pipeline()` / `parallel()` / `agent()` を組み合わせた Workflow として定義。

Workflow の基本構造:
```javascript
export const meta = {
  name: '<workflow-name>',
  description: '<1行説明>',
  phases: [{ title: 'Phase 1' }, { title: 'Phase 2' }],
}

// 各Phaseの実装
const results = await pipeline(
  dimensions,
  d => agent(d.prompt, { label: `step:${d.key}`, phase: 'Phase 1' }),
  results => parallel(results.map(r => () => agent(...)))
)
```

---

## 4. 株式会社オージャストでの適用例

### 4.1 ブース制作 成功事例の Skill 化候補

| # | 領域 | 既存 Skill | 次のステップ |
|---|---|---|---|
| 1 | キーワードリサーチ | `booth-kw-research` ✅ | Workflow 化 |
| 2 | お客様インタビュー記事制作 | `rebooth-customer-interview` ✅ | ワークフロー工程の自動化 |
| 3 | デザインデッキ作成 | `design-deck` ✅ | 複数ページ生成の Workflow 化 |
| 4 | デプロイ検証 | `deploy-verify` ✅ | CI パイプライン連携 |
| 5 | ブース料金表の作成 | （未 Skill 化） | 料金計算の定型 Workflow 化 |
| 6 | 類似イベントの案件処理 | （未 Workflow 化） | イベント種別ごとの Workflow |

### 4.2 類似イベント Workflow 処理の流れ

```
イベント情報（展示会名・規模・日程）
        ↓
  Workflow: イベントブース作成
    ① キーワード調査（booth-kw-research Skill）
    ② 見積テンプレート適用
    ③ デザインデッキ生成（design-deck Skill）
    ④ デプロイ・検証（deploy-verify Skill）
        ↓
  完了報告 + 次回改善項目の記録
```

---

## 5. 測定と改善

| KPI | 計測方法 | 目標 |
|---|---|---|
| 1回あたりのトークン消費量 | セッションサマリから抽出 | 前年比30%削減 |
| Skill 使用率 | `skill` 呼出ログ | 週10回以上 |
| Workflow 実行回数 | Workflow ログ | 週3回以上 |
| 新規セッションの立ち上がり時間 | 開始〜最初の作業まで | 従来比50%短縮 |

---

## 6. 実装ファイル

- `skills/agentrun-converter/SKILL.md` — AgentRun アプローチの Skill 定義
- 本ドキュメント — AgentRun 手法の説明と運用ガイド