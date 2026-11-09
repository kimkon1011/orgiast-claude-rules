# トークン効率 11 ルール

CLAUDE.md §1.13 の補足。claude-token-efficient プロジェクトの 11 ルールを元に
オージャストのコードベースに合わせて調整したもの。

## ルール一覧

### 1. 回答は結論から書く（Caveman スタイル）
背景説明より先に結果を書く。完了は1〜3行。検証表や【最終まとめ】は結論の後。
- §1.13: 出力は Caveman（前置きなし・完了結論1〜3行）

### 2. 質問文を短くする
1メッセージ1目的。複数の質問/依頼を詰め込まない。
- §1.15: セッションは1目的

### 3. 背景説明を削減する
毎回の全ルール再提示を避け、差分だけ伝える。
- CLAUDE.md は恒久ルールのみ、進行中タスク・今日の数字を書かない（§1.13）

### 4. モデルを使い分ける
実装=Codex、設計=Opus/Fable、軽い確認=Sonnet/Haiku。
- §1.17 費用対効果の階層: ①自動化(消費ゼロ)→②Codex/Manus(定額)→③従量最小→④Opus5は品質差を実測・正当化

### 5. 探索は軽量に
「結果200字以内・コード本体なし」で委譲。ファイル丸読みより Grep/Glob 優先。
- §1.13: Explore/general-purpose に「結果200字以内・コード本体なし」で委譲

### 6. 出力のキャッシュを維持する
変更が無いときは「変化なし」1行のみ。全文を再掲しない。
- 状態が変わらない定期報告は「変化なし」1行のみ（CLAUDE.md）

### 7. 不要なツール出力を抑制する
大きな JSON/CSV は要約して渡す。生データの全行 dump を避ける。
- token-optimizer-mcp 相当の処理

### 8. サブエージェントは軽量モデルに委譲
Explore/classify/summarize は gemini/deepseek/groq に回す。
- §1.18: 実働は Codex/Sonnet/Gemini に委譲

### 9. effortLevel を適切に設定する
既定=medium。high は設計・横断調査の時だけ。low は禁止。
- §1.13.1: medium 既定・low 禁止。節約は委譲・非Claude化・キャッシュ維持で

### 10. 大量ファイルの一括操作を避ける
`git add -A` や glob 一括処理より、必要ファイルだけを指定して操作。
- 自動セッション規約: `git add -A` 禁止。自分が変更したファイルだけ pathspec 指定

### 11. 毎回のコンテキストを最小化する
memory は MEMORY.md に1行ポインターのみ。全文を入れない。
- memory/MEMORY.md: 各 memory は1ファイル1事実、MEMORY.md はインデックスのみ

---

## 既存のトークン節約施策との対応

| ルール | 既存の施策 |
|--------|----------|
| 1 (結論から) | handoff-compact.mjs / caveman.md |
| 4 (モデル使い分け) | docs/ai-cost-unify.md / docs/x0010-prefix-cache-model-router.md |
| 5 (軽量探索) | §1.13 探索委譲ルール |
| 8 (サブエージェント委譲) | §1.18 レーン運用ルール |
| 9 (effortLevel) | settings-quality-guard |
| 11 (memory最小化) | memory-index-compact.mjs |

---
*参照: [claude-token-efficient](https://github.com/high-moctane/claude-token-efficient) / generated 2026-11-09 for X-0002*