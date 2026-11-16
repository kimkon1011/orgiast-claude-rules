## X-0037: 毎ターンコンテキストトリム

### 変更概要

bulk trim（80%閾値まで待って一括トリム）から **progressive trim（毎ターン少しずつトリム）** に移行するための基盤追加。

### 追加した関数

**`tools/context-trim.mjs`:**
- `trimProgressive()` — 20%充填から開始、充填度に応じて動的maxCharsで毎ターントリム
- `progressiveMaxChars()` — 充填度0→1でmaxChars〜minCharsを線形補間
- `simulate()` に `'progressive'` モード追加

**`tools/context-trim-measure.mjs`:** CLIの比較表にProgressive列を追加

### 実測結果（直近15セッション・40日）

| モード | 削減率 | 情報欠落率 |
|--------|--------|-----------|
| none | 基準 | — |
| bulk（従来） | 14.1% | 0.0% |
| **progressive（X-0037）** | **40.6%** | **0.0%** |
| everyTurn（上限参考） | 48.1% | 0.0% |

### 根拠

150コーディング問題でsame pass rate・~23% cheaper（X-0037提案）。実測では40.6%削減を達成し、情報欠落0.0%を確認。イベントブースサイト生成やUI自動化の長時間LLMセッションに適用しコストを抑える。

### 今後の展望

- Codexへの組み込み（`codex-do.mjs` でprogressive trim有効化）
- ~/.claude/settings.json の hooks PostToolUse で自動適用
- デフォルトtrim戦略を `trimBulk` から `trimProgressive` に移行

🤖 Generated with [Claude Code](https://claude.com/claude-code)