# X-0057 AIエージェント記事制作ワークフロー

## 概要
AIエージェントに1回の指示で記事制作の全10工程を一括実行させるための指示書セット。

## ファイル構成

| ファイル | 説明 |
|----------|------|
| `design.md` | 設計書 |
| `sample-booth-case.md` | 見本（完成形の記事サンプル） |
| `agent-role-definition.md` | AIエージェントの役割定義 |
| `10step-workflow.md` | 10工程の詳細手順 |
| `README.md` | ← このファイル |

## 使い方

### AIエージェントに渡す場合

以下の3ファイルをAIエージェント（Claude / Codex / Gemini等）に読み込ませ、10step-workflow.md の手���を指示する：

```
あなたの役割は agent-role-definition.md に定義されています。
sample-booth-case.md を見本として参照し、
10step-workflow.md の手順に従って記事を制作してください。

テーマ: <ここに記事テーマを入れる>
```

### 単独実行（Codex委譲）

```bash
# Codexに委譲する場合
node tools/codex-do.mjs "outputs/X-0057/ai-agent-article-workflow/10step-workflow.md の手順に従い、テーマ「○○展示会ブース制作事例」の記事を制作してください。役割定義は agent-role-definition.md、見本は sample-booth-case.md を参照。出力は outputs/X-0057/ai-agent-article-workflow/output/ に保存。" --cwd "C:\Users\user\.claude\auto-session-repo-fallback-20261118-003018" --timeout 600
```

## 前提条件

- AIエージェントが画像生成機能（Gemini/DALL-E）にアクセスできること
- WordPressのREST API認証情報が利用可能なこと
- 出力ディレクトリ `output/` が書き込み可能であること

## 拡張

- 工程3〜5は画像生成AIに依存するため、利用可能なモデルに応じてプロンプトを調整する
- 工程7のWordPress APIは環境に応じてエンドポイント・認証方式を変更する
- 工程6のソーシャルプルーフ収集は、API制限に注意する