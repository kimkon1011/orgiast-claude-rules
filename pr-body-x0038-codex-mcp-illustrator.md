## X-0038: Codex MCPでIllustrator作業を5分に

### 変更概要

Adobe IllustratorをCodex CLIのMCP経由で操作する `illustrator-mcp.mjs` を新規追加。自然言語の指示からExtendScript(.jsx)を生成・実行し、ブースサイン・版ずれ風見出し・パネル文字などの日常Illustrator作業を5分程度に短縮する。

### 追加ファイル

- **`tools/illustrator-mcp.mjs`** — MCPサーバー（stdio）。4つのツールを公開:
  - `generate_extendscript`: 自然言語→ExtendScript生成（Gemini or テンプレート）
  - `execute_script`: .jsxをIllustratorで実行（CLI/COM）
  - `create_text_effect`: 版ずれ風・ドロップシャドウ等のテキストエフェクト
  - `export_artboard`: アートボードのPDF/PNG書き出し
- **`tools/illustrator-mcp.test.mjs`** — 7テストケース（initialize/tools/list/script生成/エラー/フォールバック）
- **`tools/illustrator-samples/misregistration-text-effect.jsx`** — 版ずれ風テキストエフェクトのサンプルExtendScript
- **`docs/ai-news-x0038-codex-mcp-illustrator.md`** — AIニュース提案書

### テスト結果

全7テスト通過（`node --test tools/illustrator-mcp.test.mjs`）
- MCPプロトコル（initialize / tools/list / tools/call）
- LLM生成（Gemini経由で版ずれ風ExtendScriptを生成）
- テンプレート生成（LLM不在時のフォールバック）
- エラーハンドリング（未知ツール・Illustrator不在時）

### MCPサーバー設定方法

```json
// ~/.claude/settings.json に追加
{
  "mcpServers": {
    "illustrator-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/tools/illustrator-mcp.mjs"]
    }
  }
}
```

### 検証

- `node tools/illustrator-mcp.mjs --info` → Illustrator検出・COM可用性を確認
- MCP initialize応答: protocolVersion 2024-11-05
- ExtendScript生成: 版ずれ風エフェクトの完全な.jsxコードを出力
- 全テストgreen

🤖 Generated with [Claude Code](https://claude.com/claude-code)
