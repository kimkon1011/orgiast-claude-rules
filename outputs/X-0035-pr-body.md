## X-0035: Explore サブエージェントを Haiku 固定して大モデル枠節約

### 変更内容

1. **`.claude/agents/Explore.md` を作成** — 読み取り専用の探索エージェント定義
   - `model: haiku` を frontmatter に指定
   - フリート環境では `deepseek/deepseek-v4-flash`（最安モデル）に解決
   - ネイティブ環境では Claude Haiku 5.5 に解決
   - 未指定のサブエージェントは `CLAUDE_CODE_SUBAGENT_MODEL` で一括変更可能

2. **グローバル配置も実施**:
   - `~/.claude/agents/Explore.md` — ネイティブ Claude Code 用
   - `$CLAUDE_CONFIG_DIR/agents/Explore.md` — フリート (cheap-code) 用

### 効果
- 探索・ファイル検索・状態確認のサブエージェントが常に最安モデルで動作
- 検索コストを Opus high 比で 99% 超削減（実測ベース: $0.004/40コール）
- 探索作業は Haiku、考えて直す係はメインモデルのまま分離

### 既存資料
- `docs/ai-news-x0021-apply-record.md` — 事前計画（本PRで実装完了）
- `docs/ai-news-x0021-effort-haiku-subagent-costs.md` — コスト試算

🤖 Generated with [Claude Code](https://claude.com/claude-code)