## X-0031: 検索サブエージェントをHaikuへ委譲 — Scout エージェント追加

### 変更概要

ファイル検索専用のサブエージェント `.claude/agents/scout.md` を追加する。
Scout は **Read/Grep/Glob のみ** の純粋なファイル検索エージェントで、
`model: haiku`（最安モデル）に固定する。

### 既存 Explore との棲み分け

| エージェント | ツール | 役割 |
|---|---|---|
| **Explore**（既存） | Read, Glob, Grep, Bash, WebFetch, WebSearch, ToolSearch | 読み取り専用の横断調査・状態確認・ログ読み |
| **Scout（今回追加）** | Read, Glob, Grep のみ | 図面・見積・過去ブースデータの純粋なファイル検索 |

### 根拠

- 投稿スレの設定例: `model: haiku`、tools は Read/Grep/Glob
- 数値: 3日で週次100%→週全体27%減、Haiku 5.5は40x cheaper
- オージャスト適用: 図面・見積・過去ブースデータのファイル検索だけをHaiku担当にし、
  高額モデル（Opus/Sonnet）は判断・設計・レビューに残す

### テスト影響

純粋なマークダウンドキュメント追加のため、既存テストへの影響なし。

### 今後の展望

- PR #1957（X-0037 コンテキストトリム）や PR #1959（X-0036 評価トレース）との
  組み合わせで、さらにコスト削減を実現する。

🤖 Generated with [Claude Code](https://claude.com/claude-code)