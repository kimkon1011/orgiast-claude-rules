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
```

## 未実装

- AI アダプタの実本体（現在の自然言語入力はルールベース解析）
- 本番スプレッドシートとの直接接続（現在は TSV / CSV の貼り付け）
- 認証・権限管理
