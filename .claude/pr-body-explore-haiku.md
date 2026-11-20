## 変更内容

`model: haiku` → `model: claude-haiku-4-5` に変更。

## 背景

X-0061: ExploreサブエージェントをHaikuに委譲。探索コストが1/39になった実績あり。明示的に `claude-haiku-4-5` を指定することで、環境変数に依存せず確実に Haiku モデルで動作するようになる。

## 検証

- [x] `.claude/agents/Explore.md` の `model:` 行が `claude-haiku-4-5` になっていることを確認
- [x] その他の行に変更なし

🤖 Generated with [Claude Code](https://claude.com/claude-code)