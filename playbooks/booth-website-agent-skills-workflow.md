# ブース制作ウェブサイト開発：エージェントスキル6ルールワークフロー

> addyosmani/agent-skills の 25 スキルのうち、展示会ブース制作ウェブサイトに特化した 6 ルール。

## インストール済みスキル

`npx skills add addyosmani/agent-skills` → `.agents/skills/` に 25 スキルインストール済み。
`.claude/skills/` にシンボリックリンク、Skill ツール経由で呼び出し可能。

## 6 ルール（ブース固有ノート）

### 1. `/spec` — Spec-Driven Development

**汎用説明**: Skill `spec-driven-development`（`addyosmani/agent-skills` パッケージ）

**ブース固有ノート**:
- 新規イベントページ（例: 「MF-TOKYO 2027 出展ページ」「展示会ブース実績一覧」）の実装前に呼び出し
- Scope Check（Phase 0）で「出展情報」と「施工���績ギャラリー」と「問い合わせ」を Capability Map で分割してから各 SPEC を書く

### 2. `/plan` — Planning & Task Breakdown

**汎用説明**: Skill `planning-and-task-breakdown`（`addyosmani/agent-skills` パッケージ）

**ブース固有ノート**:
- SPEC 承認後に垂直スライスでタスク分割
- 各タスクは 1 セッションで完了できるサイズ（3〜5 ファイル）に抑える

### 3. `/build` — Incremental Implementation

**汎用説明**: Skill `incremental-implementation`（`addyosmani/agent-skills` パッケージ）

**ブース固有ノート**:
- Scope Discipline（Rule 0.5）: ブースページ改修中に問い合わせフォームのスタイルを触らない

### 4. `/test` — Test-Driven Development

**汎用説明**: Skill `test-driven-development`（`addyosmani/agent-skills` パッケージ）

**ブース固有ノート**:
- 単体テスト例: ブースサイズ計算（3m×3m vs 5m×5m 料金ロジック）
- Bug Fix パターン（Prove-It）: 不具合報告が来たら先に再現テストを書き、期待動作を証明してから修正

### 5. `/review` — Code Review & Quality

**汎用説明**: Skill `code-review-and-quality`（`addyosmani/agent-skills` パッケージ）

**ブース固有ノート**:
- 5 軸レビュー + ブース特化チェック: 画像の WebP/Next/Image 最適化、構造化データ（Event/Product schema）、問い合わせフォーム SPAM 対策

### 6. `/ship` — Shipping & Launch

**汎用説明**: Skill `shipping-and-launch`（`addyosmani/agent-skills` パッケージ）

**ブース固有ノート**:
- Feature Flag: `FEATURE_NEXT_EVENT=true` で先行公開（出展者確認用）と一般公開を制御
- 公開日が決まっているため、flag で段階公開する

## 開発フロー全体

1. 要件 → `/spec`（SPEC 作成→レビュー）→ `/plan`（タスク分割）
2. `/build` + `/test`（TDD で 1 スライスずつ実装）
3. `/review`（PR 作成時に 5 軸レビュー）→ `/ship`（公開前チェックリスト）

## 呼び出し方

```
/spec 展示会「MF-TOKYO 2027」の出展ページを作りたい。
/plan SPEC-mf-tokyo.md に基づいてタスク分割して。
/build タスク1 「イベント詳細スキーマと CMS 入力」を実装して。
/test ブースサイズ計算の単体テストを書いて。
/review この PR をレビューして。
/ship 公開前チェックリストを実行して。
```

または Skill ツール経由で直接呼び出し可能。