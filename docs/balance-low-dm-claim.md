# プロバイダ残高 DM 通知

- 着手: 2026-10-09 / Codex
- 目的: low・復旧・オートチャージ OFF を kim の Discord DM に独立通知する。
- 作業場所: `.wt/balance-low-dm` / `fix/balance-low-dm-20261009`
- 範囲: 実装、関連テスト、実データ dry-run、PR 作成。実 DM とマージは実施しない。

## 調査結果

`register-cost-improve-task.ps1` は `OrgiastCostImproveLoop` を毎日07:20に登録し、
`cost-improve-loop.mjs` が `collectProviderBalances` を呼んでいた。
このPCの `cost-improve-loop.log` に kimi $0 と deepseek の残高があり、未実行が原因ではない。
残高専用通知は存在せず、総合レポートの先頭に数値一覧、後段に対応依頼を入れていた。
ログの kimi 対応依頼は「💳 残高: 」を除いた文字位置でも2005で、
`notify-kim.mjs` の2,000文字切り詰めによりDM本文から欠落する。
ただし過去DMそのものの配信成否は、このログだけでは断定できない。

## 実装と検証

- 日次収集直後に独立した短いDMを送信。CLIは `--alert` / `--dry-run` を追加。
- USD閾値は$5。JST日付で日次抑止、復旧通知、OFFは前回から7日後に再通知。
- `webhookFallback: false`、配信成功後の状態保存、排他ロック、通知失敗時の継続と再試行。
- dry-runはDM・通知状態・残高履歴を書き換えない。
- 関連テスト: `node --test tools/provider-balance.test.mjs tools/notify-kim.test.mjs tools/cost-improve-loop.test.mjs`
  — pass 74 / fail 0。
- このPCの `.claude` を `ORGIAST_HOME` に指定して実データを取得した結果:

```text
[dry-run] Discord DM（送信なし）
オートチャージが OFF: deepseek（方針は全プロバイダ ON）
残高注意: kimi $0.00（オートチャージ OFF）。チャージ画面: https://platform.kimi.ai/console/pay
```

自動チャージ設定の実変更・実DM送信・マージは対象外。課金台帳の実態は維持する。
