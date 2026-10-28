# Kimi・DeepSeek の OpenRouter 経路

2026-10-28 の運用方針により、推論用の kimi / deepseek レーンは OpenRouter に固定する。必要なキーは `~/.claude/openrouter.env` の `OPENROUTER_API_KEY`（同名の環境変数を優先）。native キーだけでは起動しない。

- kimi の既定モデル: `moonshotai/kimi-k3`
- deepseek の既定モデル: `deepseek/deepseek-v4-flash`
- `--model deepseek-v4-pro` や `--model kimi-k2.5` も OpenRouter の対応 ID に変換する。完全な ID はそのまま使用する。
- `--no-fallback` でも接続先は OpenRouter。旧 native 残高切れの cooldown はこの接続を妨げない。OpenRouter 自身の cooldown は維持する。
- `cheap-code:deepseek` と Qwen 経路も同じキーを使う。Claude CLI は OpenRouter の Anthropic 互換エンドポイントを使い、GLM の接続先は従来どおり。

共通処理は `tools/provider-routing.mjs`。フォールバックの重複判定は provider と model の組み合わせで行い、OpenRouter の別モデルを消さない。`provider-catalog.mjs` はサービス・ホストの識別用であり、推論経路の設定ではないため変更しない。

台帳には実際の provider/model を記録する。API が返す `usage.cost` を USD の正本とし、未取得の行は `llm-fallback.mjs` のモデル別料金で概算する。単価は [OpenRouter のモデル一覧](https://openrouter.ai/api/v1/models) の2026-10-28時点のスナップショット。供給元・時間帯・キャッシュで実料金は変わるため実課金額を優先する。移行前の native 台帳行の単価は変更しない。

`provider-balance.mjs --alert --dry-run` は native 残高を参考表示するが、kimi / deepseek の残高注意・自動補充 OFF / 故障通知は出さない。OpenRouter の残高監視は継続する。

Claude CLI 接続の参照: [OpenRouter 公式ガイド](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration)。
