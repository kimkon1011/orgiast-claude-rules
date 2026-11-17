---
name: agentrun-converter
description: 過去の成功事例（コード・手順・判断）を Skills と Workflow に変換する AgentRun アプローチの実装。毎回の調べ直しとトークン消費を削減する。
---

# AgentRun コンバーター

## 目的

AgentRun OSS（@codexneo4）のアプローチに基づき、過去に成功した手順を Skills に、繰り返し作業を Workflow に変換する。これにより：
- 毎回の調査・設計のトークン消費を削減（約26K〜50K/回）
- 再現性の確保（同じ品質で再実行可能）
- 組織ナレッジの蓄積（誰でも使える形に）

## トリガー

- `/agentrun-convert` または `AgentRunでSkill化` / `この作業をWorkflowに` で起動

## 使用方法

```bash
# このSkillをinvoke（手順のガイダンスを表示）
Skill agentrun-converter
```

## 手順

### Phase 1: 成功事例の特定

1. 対象とする過去の作業（コード・コマンド・手順・判断）を特定
2. 以下の項目を抽出:
   - 作業の種類と目的
   - 使用したツール・CLI コマンド
   - 決定した判断基準・ルール
   - 発生した問題と解決策
   - 成果物と検証方法

### Phase 2: Skill 化

3. `skills/<short-name>/` ディレクトリを作成
4. `SKILL.md` を以下の構造で作成:

```markdown
---
name: <short-name>
description: <1行説明>
---

# タイトル

## 目的
## トリガー
## 使用方法
## 手順（箇条書き or フェーズ分割）
## 使用条件・制約
## 出力・成果物
## 関連リソース
```

5. 必要に応じて実装ファイル（CLI スクリプト・テスト）を追加

### Phase 3: Workflow 化

6. 複数の工程からなる反復作業を特定
7. Workflow スクリプトを作成（`workflows/<name>.mjs`）
8. 各工程を `agent()` に委譲し、直列/並列を設計

### Phase 4: 検証・配布

9. 新Skill/Workflow を自分で実行し動作確認
10. 全セッションで使えるよう配布（PR → マージ → converge）

## 判定基準: Skill 化すべき作業 vs 1回限り

| 基準 | Skill 化する | そのまま |
|---|---|---|
| 同じ作業を週1回以上行う | ✅ | — |
| 毎回調べ直している手順がある | ✅ | — |
| 判断に過去の決定を参照する | ✅ | — |
| 複数人が同じ作業をする | ✅ | — |
| 一度きりの使い捨て作業 | — | ✅ |
| 頻度が月1未満で手順が短い | — | ✅ |

## 使用例

### 例: ブース料金表作成の Workflow 化

```
作業: 毎月のブース料金表の更新（修正ルール・案件データを元に再計算）
→ Skill: rebooth-fee-table（料金計算ロジックを保存）
→ Workflow: 毎月1日実行（データ収集 → 計算 → 検証 → 出力）
→ 削減トークン: 毎回 15K〜25K → 初回のみ 30K（2回目以降 0）
```

## 既存 Skill の Workflow 化候補

| Skill | Workflow 化の優先度 | 備考 |
|---|---|---|
| booth-kw-research | 高 | 4Phase が Workflow に最適 |
| rebooth-customer-interview | 中 | 記事 + メールの並列生成 |
| design-deck | 高 | 複数ページの並列ビルド |
| deploy-verify | 中 | CI パイプラインとの連携 |