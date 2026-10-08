# AI API オートチャージ設定（kim向け・2026-09-09）

■ 設定状況(完了)

kim が行う設定の残タスクはありません。以下は2026-09-09時点の確認済み状況です。

1. OpenRouter（seisaku-team@orgiast.jp）: オートチャージ ON 済み（kim 実施）。[Credits設定](https://openrouter.ai/settings/credits) で設定を確認できます。
2. xAI（Grok）: オートチャージ ON・月間上限設定済み（kim 実施）。[xAI Console](https://console.x.ai/) の Billing で確認できます。
3. DeepSeek: 2026-09-09 に kim が PayPal で $100 を手動チャージ済み。自動チャージ機能はありません。
4. Kimi: 自動チャージ機能がないため操作不要です。DeepSeek / Kimi は OpenRouter 経由を既定とし、直接呼び出しは現在の残高を使い切るまでフォールバックとして使います。
5. Gemini: 変更なし。自動支払い ON、月上限 ¥20,000 設定済みです。
6. Groq: Developer tier は「temporarily unavailable due to high demand」と表示され、申込不可（スクリーンショットで確認済み）。無料枠のまま運用します。[Billing設定](https://console.groq.com/settings/billing) で申込が再開したら、改めて案内します。現時点で kim の操作は不要です。

■ 今後の運用

残高確認・異常停止・通知は Claude 側が日次で行います。Groq は spend_anomaly と HTTP 429 を監視します。
カード番号や API キーを共有する必要はありません。Claude の日次 DM 先頭に残高概要が表示されます。
