# 評価制度 AI 自動化プロトタイプ

AIニュース提案 P-0126 を元に、スプレッドシートで管理されている評価制度を Web アプリ化するプロトタイプです。評価基準・スタッフ・5段階評価の入力、重み付きスコアと等級の算出、集計・統計をブラウザ内で行います。データは外部送信せず、`localStorage` の `evaluation-ai-data` に保存します。

## 起動方法

依存パッケージはありません。ES Modules を使うため、リポジトリのルートで次を実行し、ブラウザで `http://localhost:8000/apps/evaluation-ai/` を開きます。

```sh
python3 -m http.server 8000
```

Windows で `python3` がない場合は `python -m http.server 8000` でも起動できます。

## テスト

Node.js 18 以上で実行します。

```sh
node --test apps/evaluation-ai/test/evaluation-ai.test.mjs
node --test apps/evaluation-ai/test/ui-eval-loop.test.mjs  # X-0018 UI評価ループ
```

## モジュール

| モジュール | 説明 |
|-----------|------|
| `index.html` | 評価制度 Web アプリ（localStorage保存） |
| `eval-engine.mjs` | 加重スコア・等級・統計計算エンジン |
| `nl-input.mjs` | 自然言語入力解析（ルールベース + AIアダプタ） |
| `sheet-import.mjs` | TSV/CSV 貼り付け取り込み |
| `store.mjs` | localStorage ラッパー |
| `uivisual-eval.mjs` | **[X-0018]** UI視覚評価エンジン（一貫性・独創性・ユーザビリティ） |
| `build-agent.mjs` | **[X-0018]** 構築エージェント（評価→フィードバック→改訂ループ） |

## X-0018: UI改善ループ

構築エージェントと評価エージェントを分離したUI改善ループのプロトタイプです。

### 評価基準

| カテゴリ | 項目 | 重み |
|---------|------|------|
| 視覚的一貫性（V1〜V5） | カラーパレット・タイポグラフィ・スペーシング・コンポーネント・状態 | 3 |
| 独創性（O1〜O3） | テンプレート回避・レイアウトバリエーション・ビジュアル階層 | 2 |
| ユーザビリティ（U1〜U3） | 応答性・アクセシビリティ・パフォーマンス | 2 |

### 使用方法（コードから）

```js
import { evaluate, analyzeColors, analyzeAccessibility } from './uivisual-eval.mjs';
import { runImprovementLoop, formatReport } from './build-agent.mjs';

// 単発評価
const result = evaluate({ V1: 4, V2: 5, U1: 3 });
console.log(result.verdict); // 'pass' | 'revision'

// 改善ループ
const loopResult = await runImprovementLoop(
  async (feedback) => { /* フィードバックに基づき修正 */ },
  async () => { /* 現在のスコアを返す */ },
  { maxIterations: 3 }
);
console.log(formatReport(loopResult.records));
```

## 未実装

- AI アダプタの実本体（現在の自然言語入力はルールベース解析）
- 本番スプレッドシートとの直接接続（現在は TSV / CSV の貼り付け）
- 認証・権限管理
- X-0018: 実際のブラウザレンダリングを用いた視覚的検証
