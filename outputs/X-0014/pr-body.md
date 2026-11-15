# X-0014: Grok Bot + Claude Code コーディング手順

AIニュース提案 X-0014「Grok Bot + Claude Code のコーディング手順」の設計文書とブリッジツールを実装。

## 変更内容

### 新規ファイル
- `docs/ai-news-x0014-grok-bot-coding-workflow.md` — ワークフロー設計文書（Grok Bot リサーチ→実装プロンプト→Claude Code/Devin実装→Grok Bot QA→デプロイ）
- `tools/grok-bot-prompt-bridge.mjs` — Grok Bot のリサーチ結果JSONを Claude Code 向け実装プロンプト（Markdown）に変換するCLIツール
- `tools/grok-bot-prompt-bridge.test.mjs` — テストスイート（7 tests）
- `outputs/X-0014/sample-grok-research.json` — オージャスト自社ウェブサイト更新シナリオのサンプルリサーチJSON
- `outputs/X-0014/pr-body.md` — 本PRの本文

### 更新ファイル
- `outputs/X-0014/README.md` — 新規成果物の説明を追記

## 注目ポイント

1. **Phase 分離**: Grok Bot（リサーチ・QA）と Claude Code/Codex（実装）を明確に分離し、各AIの得意領域に専念させる
2. **自信度フィルター**: ブリッジツールは `confidence: high` の finding のみ実装要件に採用し、`low` は除外（ハルシネーション対策）
3. **スマホ介入**: Grok アプリから Phase 1〜4 の任意ポイントで方向修正・承認が可能
4. **第三者QA**: 実装後は Grok Bot が別視点で検証（自己検証の見落としを低減）

## 検証結果

```
node --test tools/grok-bot-prompt-bridge.test.mjs → 全テスト pass
```

## 残タスク

- [ ] 実環境でのエンドツーエンドテスト（Grok API 経由のリサーチ→実装→QA）
- [ ] スマホ介入パターンの実測（Grok アプリのOperation Type制約確認）
- [ ] Devin 連携パターンの検証

🤖 Generated with [Claude Code](https://claude.com/claude-code)