<!-- tools/ai-subscription-catalog.json から tools/ai-subscription-inventory.mjs --write で生成。手で編集しない。 -->

# AIサブスクリプション棚卸し・統合提案

全社で利用中のAIサービスを一覧化し、重複するプランの統合・解約で月額費用を削減する（AIニュース提案 P-0133）。

## 一覧

| サービス | ベンダー | 課金形態 | 月額 | キー | 実使用 |
| --- | --- | --- | --- | --- | --- |
| Claude Team seats (claude-team) | Anthropic | seat | 未記入 | anthropic.env | 0 |
| ChatGPT (Codex) subscriptions (codex) | OpenAI | seat | 未記入 | 未検出 | 902 |
| Z.ai GLM Coding Plan (glm) | Z.ai | plan | ¥1,890 | zai-kim.env, zai-seisaku.env, zai.env | 391 |
| Cursor Pro (cursor) | Anysphere | plan | ¥3,000 | 未検出 | 0 |
| Genspark Pro (genspark) | Genspark | prepaid | 未記入 | genspark-proxy.env, genspark.env | 74 |
| Cerebras Code (cerebras) | Cerebras | plan | 未記入 | 未検出 | 0 |
| Google Gemini（autopay 上限） (gemini) | Google | cap | ¥20,000（上限・固定費除外） | 未検出 | 1624 |
| Groq (groq) | Groq | metered | 未記入 | groq.env | 1950 |
| DeepSeek (deepseek) | DeepSeek | metered | 未記入 | deepseek.env | 800 |
| OpenRouter (openrouter) | OpenRouter | metered | 未記入 | openrouter.env | 1581 |
| xAI Grok (grok) | xAI | metered | 未記入 | xai.env | 94 |
| Moonshot Kimi (kimi) | Moonshot | metered | 未記入 | kimi-api.env | 16 |
| Mistral (mistral) | Mistral AI | metered | 未記入 | mistral.env | 1 |

## 検出した問題

- [warn] Claude Team seats (claude-team): 月額未記入、棚卸し未完
- [warn] ChatGPT (Codex) subscriptions (codex): 月額未記入、棚卸し未完
- [warn] Z.ai GLM Coding Plan (glm): ZAI_API_KEY が 3 本に存在（zai-kim.env, zai-seisaku.env, zai.env）。キー名の重複であり契約数は未確認
- [warn] Genspark Pro (genspark): 月額未記入、棚卸し未完
- [warn] Cerebras Code (cerebras): 月額未記入、棚卸し未完
- [warn] Cerebras Code (cerebras): 実行レーンに配線済みだが実使用ゼロ＝解約候補
- [warn] コーディングCLI・実装エージェント (code) が固定費 5 サービスで重複: Claude Team seats (claude-team), ChatGPT (Codex) subscriptions (codex), Z.ai GLM Coding Plan (glm), Cursor Pro (cursor), Cerebras Code (cerebras)
- [warn] 汎用チャット・テキスト生成 (chat) が固定費 2 サービスで重複: Claude Team seats (claude-team), Genspark Pro (genspark)
- [warn] 調査・検索・資料生成 (research) が固定費 2 サービスで重複: Cursor Pro (cursor), Genspark Pro (genspark)
- [info] Claude Team seats (claude-team): 実使用を台帳で観測できない（実行レーン外）。契約条件は手動で確認
- [info] Cursor Pro (cursor): 実使用を台帳で観測できない（実行レーン外）。契約条件は手動で確認
- [info] Google Gemini（autopay 上限） (gemini): 課金設定が未検証
- [info] Groq (groq): 課金設定が未検証
- [info] DeepSeek (deepseek): 課金設定が未検証
- [info] OpenRouter (openrouter): 課金設定が未検証
- [info] xAI Grok (grok): 課金設定が未検証
- [info] Moonshot Kimi (kimi): 課金設定が未検証
- [info] plaud.env: PLAUD_PROXY_SECRET はカタログ未登録＝棚卸し漏れの疑い
- [info] plaud.env: PLAUD_URT はカタログ未登録＝棚卸し漏れの疑い
- [info] plaud.env: PLAUD_UT はカタログ未登録＝棚卸し漏れの疑い
- [info] tldv.env: TLDV_API_KEY はカタログ未登録＝棚卸し漏れの疑い

## 削減見込み

- 確実: ¥0
- 統合候補: 算定不能（金額不明を含む）
- 金額不明 4 件
- 統合候補は用途グループ別の試算合計。同じサービスが複数用途に属するため重複し得る。確実分とも合算しない。
- 実使用は executor-usage.jsonl の記録範囲。解約前に台帳外の利用と契約条件を確認する。

## 統合・解約の進め方

- 金額不明を埋める。budget-fixed.json の固定費を更新する。
- 重複キーを1本に統合する。利用者と参照先を確認して切り替える。
- 実使用ゼロの固定費を解約する。台帳外の利用と契約条件を確認する。
- 四半期ごとに再実行する。実使用と費用を再確認する。
