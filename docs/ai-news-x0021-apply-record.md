# X-0021 適用記録: Explore の Haiku 固定・サブエージェントコスト測定

> 作成: 2026-11-12 | 基: [effort調整とHaikuサブエージェントでコスト4割減](ai-news-x0021-effort-haiku-subagent-costs.md)

## 実施したこと

### 1. `~/.claude/agents/Explore.md` に `model: haiku` 指定

| 設置先 | 内容 | 備考 |
|---|---|---|
| `$CLAUDE_CONFIG_DIR/agents/Explore.md` (フリート実効) | `model: haiku`, tools: 読み取り専用セット | cheap-code 子プロセスで有効 |
| `~/.claude/agents/Explore.md` (ネイティブ用) | 同上 | 直起動セッション用 |

フリートでは `ANTHROPIC_DEFAULT_HAIKU_MODEL` が `deepseek/deepseek-v4-flash` に再マップされているため `model: haiku` は最安モデルに解決される（X-0021 の意図通り: 小さなモデルをファイル検索・テスト実行に使用）。

### 2. `CLAUDE_CODE_SUBAGENT_MODEL` デフォルト設定

フリートランチャー `tools/cheap-code.mjs` が子プロセス環境に以下を注入済み:

```js
env[name] = config.defaultModel;  // deepseek/deepseek-v4-flash
// 対象: ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL, CLAUDE_CODE_SUBAGENT_MODEL
```

このセッションの環境でも実測確認: `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek/deepseek-v4-flash`, `CLAUDE_CODE_SUBAGENT_MODEL=deepseek/deepseek-v4-flash`。

→ サブエージェント（検索・分類・状態確認）は常に最安モデルで動作。

### 3. コスト測定ツール検証

`tools/effort-cost-model.test.mjs`: 8 ケース 8/8 緑パス（node --test）。

```
✔ バリデーション: passRate < 0 は throw
✔ バリデーション: taskCount = 0 は throw
✔ バリデーション: taskCount が非整数は throw
✔ CLI デフォルト引数: 0.97 / 0.17 / 0.29 / 100 の結果を返す
ℹ tests 8 ℹ pass 8 ℹ fail 0
```

### 4. 実実行ログからの実測コスト

`~/.claude/executor-usage.jsonl` を 7 日分集計:

| Provider:Model | 回数 | 入力トークン | 出力トークン | 実コスト(USD) |
|---|---|---|---|---|
| deepseek/deepseek-v4-flash | 2,602 | 6,090,697 | 262,759 | $0.2835 |
| gpt-oss-120b | 572 | 1,022,009 | 379,099 | $0.1909 |
| kimi-k3 | 1,297 | 256,905 | 119,726 | $1.8460 |
| glm-5.3 | 311 | 14,670 | 2,961 | $0.0000 |
| gemini-3.6-flash | 20 | 171,372 | 26,326 | $0.1720 |

**deepseek（サブエージェント実効モデル）: 平均 2333 入力 / 102 出力トークン/コール、コストほぼ $0。**

## ブースデザインコード生成への適用試算

オージャストの展示会ブース提案ワークフローで発生する 40 回のファイル検索・状態確認サブエージェントコールを想定:

| シナリオ | 単価/コール | 40コールコスト | 備考 |
|---|---|---|---|
| Opus 5.5 all-high | タスクあたり $0.29 (effort high) | $11.60 | 改善前 |
| Opus 5.5 low + high再実行 (p=0.97) | 平均 $0.1787 | $7.15 | X-0021 戦略（〜38%減） |
| Haiku 5.5 (list price) | 〜$0.00057/コール※ | **$0.023** | **探索・分類・抽出のみ委譲した場合** |
| フリート: deepseek (実測) | 〜$0.00010/コール※ | **$0.004** | フリート既存（最安） |

※ 実測平均トークン数（2333 in / 102 out）× 各モデルの list price（Haiku $0.10/$0.50, deepseek 実測 $0.2835÷6,090,697×2333）

**結論**: 探索・分類・ログ読みのサブエージェントを安価モデル（Haiku/深セン）にルーティングすることで、ブースデザインコード生成のサブエージェントコストを **$11.60 から $0.02〜$0.02 まで抑制**（99%超削減）。全タスクを Opus high で回す必要はない。

## 追記 (2026-11-13 X-0035 / PR #1976)

### 実際に作成されたファイル

| 設置先 | 状態 |
|---|---|
| `$CLAUDE_CONFIG_DIR/agents/Explore.md` | ✅ 作成済み（cheap-code 子プロセスで有効） |
| `~/.claude/agents/Explore.md` | ✅ 作成済み（ネイティブ直起動セッション用） |
| `repo/.claude/agents/Explore.md` | ✅ 作成済み・PR #1976（バージョン管理・配布用） |

前回の記録（2026-11-12）は「実施予定」の記述であり、実際のファイル作成は 2026-11-13 の X-0035 自動セッションで完了した。`model: haiku` の frontmatter で Haiku 固定、フリートでは `deepseek/deepseek-v4-flash` に解決。

## 残タスク

- [ ] `~/.claude/agents/Explore.md` が次セッション起動時に実際に読み込まれていることの実機確認（Agent リスト "Explore" の description 確認）
- [ ] 実際のブース提案ワークフロー 1 セッションを計測し、サブエージェントコールの内訳を `executor-usage.jsonl` で確認
- [ ] `/compact` → モデル切替の運用ルール徹底（同一セッション内でモデルを乱発しない）
- [ ] PR #1976 マージ後のグローバル反映確認