# GitHub Copilot 定額/従量 判定（2026-09-19）

> このファイルは生成物。手で編集しない。再生成: `node tools/copilot-flatrate-plan.mjs --seats 30 --plan business --write`

## 判定: 上限確定 ○ / 従量 OFF

**Copilot は完全な定額制ではない。** コード補完・next edit suggestions は無制限（AIクレジット非消費）だが、AIクレジット超過分は従量課金。

## 前提

- seats: 30（CLI入力値）
- plan: Copilot Business / $19/seat/月 / 1900 credits/seat/月（一次情報で確認: https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises）
- 使用量: 未計測
- 為替: 150 JPY/USD（組織の試算用既定値、未確認。CLIで上書き可）
- 予算: ¥150,000/月 = $1000.00（組織の月次ハード上限）
- 追加クレジット: $0.01/credit（一次情報で確認: https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises）

## 金額

- 固定シート: $570.00 / ¥85,500（一次価格から算出）
- 共有プール: 57,000 credits/月（一次値から算出）
- 使用クレジット: 未計測
- 超過クレジット: 未計測
- 従量分: $0.00 / 合計: $570.00（¥85,500）
- 確定上限: $570.00 / ¥85,500
- 予算超過: $0.00 / ¥0

## 予算が破れる境界

- 従量を許可した場合: seat平均 3333.33 credits/seat/月超（算出値）
- 損益分岐指標: 3800.00 credits/seat/月（含有credits + seat価格 ÷ $0.01）
- 未計測: 1 件。実費はこれより大きい可能性があり、削減額・損益分岐の達成を断定しない。

## 管理上の注意

- チームプランは seat 数 × credits/seat の共有プール（一次情報で確認: https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises）。
- user / cost center / enterprise 単位の budget controls がある（一次情報で確認: https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises）。
- 予算到達時の停止は「Copilot pauses until the next cycle」と記載されるが、hard stop の保証は **未確認 (unverified)**（https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises）。

## 出典

- https://docs.github.com/en/copilot/get-started/plans
- https://github.com/features/copilot/plans
- https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises
- https://docs.github.com/en/copilot/concepts/billing/individual-plans

