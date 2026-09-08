# AI API オートチャージ設定（kim向け）

支払い操作だけは本人にしかできません。以下を上から1回ずつ設定すれば、以後の残高確認・異常停止・通知はClaude側が日次で行います。

1. **OpenRouter（seisaku-team@orgiast.jp）**: [Credits設定](https://openrouter.ai/settings/credits) を開く → `Add credits` でカードを登録 → `Auto Top-Up` を ON → 閾値 **$5**、追加額 **$25**。月間消費の実測が $2 未満なので、$25 は約1年分の目安です。
2. **xAI（Grok）**: [xAI Console](https://console.x.ai/) → `Billing` → `Auto-reload` を ON → `Monthly spending limit` を **$20**。
3. **DeepSeek / Kimi**: 自動チャージ機能がないため操作不要です。Claude側でOpenRouter経由を既定にし、現在の残高を使い切るまで直叩きをフォールバックとして使います。
4. **Gemini**: 自動支払いON、月上限 **¥20,000** 設定済みです。変更不要です。
5. **Groq**: [Billing設定](https://console.groq.com/settings/billing) → `Upgrade` → カード登録。Developer tier（従量・後払い）へ移行します。無料枠は直近7日で失敗率50%と不安定なためです。上限はClaude側の `spend_anomaly` で監視します。

設定後にカード番号やAPIキーを共有する必要はありません。Claudeの日次DM先頭に残高概要が表示されます。
