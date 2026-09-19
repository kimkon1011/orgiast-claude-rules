# プロンプト商材の購入価値 実測（P-0100）

> このファイルは生成物。手で編集しない。再生成: `node tools/prompt-product-eval.mjs --write`
> 台帳: `tools/prompt-product-catalog.json` / 実測: `tools/prompt-product-eval.results.json`
> 出典区分: `primary`=一次情報 / `media`=報道 / `assumed`=前提値 / `unknown`=未取得

## 結論

- groq/openai/gpt-oss-120b: plain 33.3%、pack 0.0%（lift -33.3%）、workflow 100.0%（lift 66.7%）。
- 汎用プロンプト集（ロール付与・一般論型）: 購入価値なし（価格 3,980円 / 損益分岐 -15,000円）。
- 業務ロジック埋め込み型プロンプト: 条件付きで価値あり（価格 29,800円 / 損益分岐 30,000円）。
- deepseek/deepseek-chat: plain 25.0%、pack 0.0%（lift -25.0%）、workflow 100.0%（lift 75.0%）。
- 汎用プロンプト集（ロール付与・一般論型）: 購入価値なし（価格 3,980円 / 損益分岐 -11,250円）。
- 業務ロジック埋め込み型プロンプト: 条件付きで価値あり（価格 29,800円 / 損益分岐 33,750円）。
- 汎用型はどのモデルでも素の依頼を上回らなかった: 該当（lift.pack が全モデルで0以下）。
- 業務ロジック型の合格率は 100.0% 以上（最低値）。
- つまり「プロンプトの書き方」より「出力契約・例外規則・実例の有無」が合格率を支配している。本計測は汎用型商材の購入価値を支持しない。

## 実測結果

| model | variant | 合格率 | n | errors | 平均出力tok | 1タスクあたり円 | 平均ms |
|---|---|---:|---:|---:|---:|---:|---:|
| groq/openai/gpt-oss-120b | plain | 33.3% | 12 | 0 | 115.4 | 0.0134 | 643 |
| groq/openai/gpt-oss-120b | pack | 0.0% | 12 | 0 | 334.5 | 0.0358 | 1130 |
| groq/openai/gpt-oss-120b | workflow | 100.0% | 12 | 0 | 163.8 | 0.0201 | 719 |
| deepseek/deepseek-chat | plain | 25.0% | 12 | 0 | 157.4 | 0.0287 | 1256 |
| deepseek/deepseek-chat | pack | 0.0% | 12 | 0 | 357.2 | 0.0659 | 2317 |
| deepseek/deepseek-chat | workflow | 100.0% | 12 | 0 | 23.3 | 0.0099 | 677 |

## リフト

| model | lift.pack | lift.workflow | noiseBand |
|---|---:|---:|---:|
| groq/openai/gpt-oss-120b | -33.3% | 66.7% | 10.0% |
| deepseek/deepseek-chat | -25.0% | 75.0% | 10.0% |

## 商材価値の判定

| model | 商品名 | 価格（前提） | 損益分岐価格 | 判定 | 理由 |
|---|---|---:|---:|---|---|
| groq/openai/gpt-oss-120b | 汎用プロンプト集（ロール付与・一般論型） | 3,980円 | -15,000円 | 購入価値なし | 上乗せ効果が測定誤差帯 0.1 以下 |
| groq/openai/gpt-oss-120b | 業務ロジック埋め込み型プロンプト | 29,800円 | 30,000円 | 条件付きで価値あり | 自分で書くより高いが損益分岐内 |
| deepseek/deepseek-chat | 汎用プロンプト集（ロール付与・一般論型） | 3,980円 | -11,250円 | 購入価値なし | 上乗せ効果が測定誤差帯 0.1 以下 |
| deepseek/deepseek-chat | 業務ロジック埋め込み型プロンプト | 29,800円 | 33,750円 | 条件付きで価値あり | 自分で書くより高いが損益分岐内 |

## 価格感度

| model | 商品 | 価格円 | 判定 |
|---|---|---:|---|
| groq/openai/gpt-oss-120b | generic-pack | 1,000 | 購入価値なし |
| groq/openai/gpt-oss-120b | generic-pack | 5,000 | 購入価値なし |
| groq/openai/gpt-oss-120b | generic-pack | 10,000 | 購入価値なし |
| groq/openai/gpt-oss-120b | generic-pack | 30,000 | 購入価値なし |
| groq/openai/gpt-oss-120b | generic-pack | 100,000 | 購入価値なし |
| groq/openai/gpt-oss-120b | workflow-pack | 1,000 | 条件付きで価値あり |
| groq/openai/gpt-oss-120b | workflow-pack | 5,000 | 条件付きで価値あり |
| groq/openai/gpt-oss-120b | workflow-pack | 10,000 | 条件付きで価値あり |
| groq/openai/gpt-oss-120b | workflow-pack | 30,000 | 条件付きで価値あり |
| groq/openai/gpt-oss-120b | workflow-pack | 100,000 | 購入価値なし |
| deepseek/deepseek-chat | generic-pack | 1,000 | 購入価値なし |
| deepseek/deepseek-chat | generic-pack | 5,000 | 購入価値なし |
| deepseek/deepseek-chat | generic-pack | 10,000 | 購入価値なし |
| deepseek/deepseek-chat | generic-pack | 30,000 | 購入価値なし |
| deepseek/deepseek-chat | generic-pack | 100,000 | 購入価値なし |
| deepseek/deepseek-chat | workflow-pack | 1,000 | 条件付きで価値あり |
| deepseek/deepseek-chat | workflow-pack | 5,000 | 条件付きで価値あり |
| deepseek/deepseek-chat | workflow-pack | 10,000 | 条件付きで価値あり |
| deepseek/deepseek-chat | workflow-pack | 30,000 | 条件付きで価値あり |
| deepseek/deepseek-chat | workflow-pack | 100,000 | 購入価値なし |

## 前提値（assumed）

| 項目 | 値 | 検証状態 |
|---|---:|---|
| fixMinutesPerFailure | 3 | assumed（実測ではない） |
| tasksPerMonth | 100 | assumed（実測ではない） |
| hourlyYen | 3000 | assumed（実測ではない） |
| selfWriteMinutes | 10 | assumed（実測ではない） |
| paybackMonthsTarget | 3 | assumed（実測ではない） |
| noiseBand | 0.1 | assumed（実測ではない） |
| usdJpy | 150 | assumed（実測ではない） |

- **結論を支配する前提:** fixMinutesPerFailure=3、tasksPerMonth=100、hourlyYen=3000、paybackMonthsTarget=3。これらが損益分岐価格を直接決める。

## 未検証

- 実際に販売されている商材の中身は購入していない。
- 商品価格と価格帯は想定であり、個別商品の実売価格ではない。
- 対象モデルと6タスクに限定した結果であり、一般化には追加計測が必要。
- プロンプトの言い回しを変えると結果が動きうる。
- API失敗はerrorsとして合格率の分母から除外し、表に件数を明記する。

## 出典

- 一次情報なし（本計測は自前タスクによる実測）。

