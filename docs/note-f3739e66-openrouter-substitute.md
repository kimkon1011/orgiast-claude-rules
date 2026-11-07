# Note: f3739e66 からの未マージ知見

**出典**: ブランチ `fix/lane-missing-key-openrouter-substitute` (worktree削除済み)
**状態**: main には PR #1615 で同目的の別実装がマージ済み。
  ただし f3739e66 には以下が含まれており、main 未取込:

1. **OPENROUTER_SUBSTITUTE_MODELS** — provider-routing.mjs に複数プロバイダの代替モデルを一元定義
   (gemini/deepseek/kimi/mistral)。PR #1615 は hardcoded な `p === 'gemini'` のみ。

2. **missing_key_substituted 通知区分** — 鍵不在を workers に知らせるが lane-repair-first を停止させない。

**判断**: `provider-routing.mjs` の抽象化は価値あり。主と分離して取り込むなら
  docs/ メモとして保存後、ブランチ削除可。
