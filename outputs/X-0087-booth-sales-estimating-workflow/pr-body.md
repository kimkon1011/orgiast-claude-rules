## Summary

- AIニュース提案 X-0087（next-session 題名「検索結果: AI exhibition booth event production sales estimating workfl」）を、オージャスト自社PR（PR TIMES 2026-10-30）に基づき文書化
- 既存の同番号文書 `docs/ai-news-x0087-ai-learning-5-steps-automation.md`（PR #2336・AI学習の5ステップ）とは別内容のため、衝突回避のファイル名で併存（上書きなし）
- 営業→見積→実施計画→購買→施工計画のフロー図、内製4システムと現行スキル（`orgiast-mitsumori` / `case-*` 等）の対応、ルール毎日改良チェックリスト、マキモノ・AI代行堂との境界を記載

## 追加ファイル

- `docs/ai-news-x0087-exhibition-booth-sales-estimating-workflow.md`
- `outputs/X-0087-booth-sales-estimating-workflow/README.md`
- `outputs/X-0087-booth-sales-estimating-workflow/pr-body.md`

## 安全境界

- 文書のみ。本番変更・外部送信・承認待ち成果物の新規作成なし
- 秘匿値・顧客PIIなし
- アプリからの Claude API 新規利用は提案しない（他AI既定・ONBOARDING §2.8.0）
- 既存 `ai-news-x0087-ai-learning-5-steps-automation.md` は未改変

## Test plan

- [ ] 新規3ファイルが存在し、既存 X-0087 学習5ステップ文書が残っている
- [ ] 本文に出典URL・観測日 2026-11-25・番号衝突注記がある
- [ ] mermaid または同等のワークフロー図がある
- [ ] 実在しないAPIパスの捏造が無い
