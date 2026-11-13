---
name: create-verification-skill
description: AIコーディングの検証シナリオを作成・管理し、変更後の再現検証を自動化する。X-0048「AIコーディングエージェントの検証組み込み」の中核スキル。トリガー語：「検証シナリオ」「verification scenario」「/create-verification-skill」
---

# Create Verification Skill — AIコーディングエージェント検証組み込み

> 関連: X-0048, X-0012, X-0025, deploy-verify skill

## 概要

AIコーディングエージェントが生成したコードの**変更前後で同一シナリオをリプレイ**し、挙動一致・非退行・品質維持を自動検証するためのスキル。

以下の6要素を実現する:

1. **失敗ケースの保存**: パッチ・コマンド・リクエストペイロード・UIステップを構造化
2. **シナリオキャプチャ**: スタートアップから実行ステップまでを保存
3. **変更後リプレイ**: 同一シナリオを再実行して挙動一致を確認
4. **フォームジャーニーマップ**: ルート・権限・テストデータ・安定制御点・失敗状態を定義
5. **クレーム↔証拠マッチ**: 動作・パフォーマンス・コード品質の3軸でクレームを証拠に紐付け
6. **フィーチャー境界強制**: importグラフによる許可/禁止インポートテスト

## 使用方法

### 1. 検証シナリオの作成

```sh
# 新規シナリオテンプレートを生成
node tools/verification-scenario.mjs capture "展示会出展申込フォーム" "apps/expo-apply/index.html"

# 生成された JSON を編集して actual 値を埋める
# → docs/evidence/scenarios/<scenario-id>.json
```

### 2. シナリオの妥当性検証

```sh
node tools/verification-scenario.mjs validate docs/evidence/scenarios/expo-apply-booth-form.json
```

### 3. シナリオのリプレイ（dry-run）

```sh
node tools/verification-scenario.mjs replay docs/evidence/scenarios/expo-apply-booth-form.json
```

### 4. フォームジャーニーマップの表示

```sh
node tools/verification-scenario.mjs map docs/evidence/scenarios/expo-apply-booth-form.json
```

### 5. 利用可能なシナリオ一覧

```sh
node tools/verification-scenario.mjs list
```

## 検証シナリオの構造

各シナリオは以下の要素を持つ JSON ファイル (`docs/evidence/scenarios/*.json`) として定義する:

| 要素 | 必須 | 説明 |
|------|------|------|
| `schema` | ✅ | スキーマバージョン（`x0048-v1`） |
| `id` | ✅ | 一意識別子 |
| `name` | ✅ | シナリオ名 |
| `target` | ✅ | 検証対象ファイル/URL |
| `tags` | 任意 | 分類タグ |
| `journey` | 任意 | フォームジャーニーマップ |
| `steps` | ✅ | 検証ステップ配列 |
| `failureCases` | 任意 | 既知の失敗ケース |
| `claimEvidence` | 任意 | クレーム↔証拠マッピング |

### ステップ種別

| 種別 | 説明 | ペイロード例 |
|------|------|-------------|
| `navigate` | URL/ページ遷移 | `{ url: "/" }` |
| `fill` | フォーム入力 | `{ selector: "#email", value: "test@test.com" }` |
| `click` | クリック操作 | `{ selector: "#submitBtn" }` |
| `assert` | 状態アサーション | `{ selector: "#confRef", expected: { visible: true } }` |
| `api` | APIリクエスト | `{ method: "GET", url: "/api/data" }` |
| `wait` | 待機 | `{ ms: 1000 }` |

### クレーム↔証拠マッピング（3軸）

変更のたびに「動いた」という主張だけでなく、以下の3軸で証拠と紐付ける:

1. **動作 (Behavior)**: 実ジャーニー再現 + スクリーンショット
2. **パフォーマンス (Performance)**: 同等ビルド比較（変更前後のタイミング）
3. **コード品質 (Code Quality)**: types + lint + 回帰テスト

## 適用手順（変更時）

1. **変更前**: `node tools/verification-scenario.mjs replay <scenario>` でベースライン取得
2. **変更**: AIコーディングエージェントでコード変更
3. **変更後**: 同一シナリオをリプレイして差分確認
4. **検証**: 全ステップ PASS + 既存テスト緑 + 証拠台帳に記録
5. **報告**: 検証結果（PASS/FAIL + 証拠パス）を報告

## フィーチャー境界強制（importグラフ）

feature 間の依存関係を import グラフで強制するためのテストパターン:

```js
// tools/feature-boundary-test.mjs（概念実証）
const ALLOWED_IMPORTS = {
  'apps/expo-apply/index.html': [],         // エントリポイントは外部依存なし
  'apps/expo-apply/expo-apply-core.mjs': [], // コアモジュールは依存なし（pure）
};
const FORBIDDEN_IMPORTS = {
  'apps/expo-apply/expo-apply-core.mjs': ['node:fs', 'node:http'], // pure であるべき
};

export function checkFeatureBoundaries(files) {
  const violations = [];
  for (const [file, imports] of Object.entries(files)) {
    for (const imp of imports) {
      if (FORBIDDEN_IMPORTS[file]?.includes(imp)) {
        violations.push(`${file} は ${imp} を import してはいけません`);
      }
    }
  }
  return { valid: violations.length === 0, violations };
}
```

## 期待効果

| 指標 | 現状 | 目標 |
|------|------|------|
| 変更後の手動確認時間 | 15〜30分 | 0分（自動リプレイで完了） |
| 本番発覚不具合 | 月1〜2件 | 0件 |
| クレーム↔証拠の追跡 | なし | 全変更に3軸証拠あり |
| フィーチャー境界違反 | 手動レビュー | importグラフ自動検査 |

## 既存の関連スキル・ツール

- `skills/deploy-verify/SKILL.md` — 2段検証（Layer1:ロジック / Layer2:ブラウザ）
- `docs/ai-news-x0012-verifiable-reproducible-workflow.md` — 5コンポーネント検証ワークフロー
- `docs/ai-news-x0025-agent-validation-workflow.md` — OSSツール統合（Promptfoo/LangGraph/Langfuse）
- `tools/verification-scenario.mjs` — 検証シナリオCLI（本スキルの中核��ール）
