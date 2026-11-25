> このファイルは生成物。手で編集しない。再生成: `node tools/report-automation.mjs --write`

# AI支援レポート自動化による人手削減（P-0147）

## 結論

**条件付きで有効** — 削減率は閾値以上だが前提または未自動化ステップが未検証。
手作業 145分 / 自動化後 29.001分 / 削減 80.0%。

## 自動化パイプラインの実測

対象期間: 2026-09 / 前月: 2026-08 / 広告 6 行 / ディール 9 行 / 重複除去 1 件 / パイプライン 32.0 ms。

以下は同梱CSVの参考集計。実測runの有無にかかわらず再集計し、過去runの出力を復元するものではない。

### 集計

対象期間: 2026-09 / 前月: 2026-08。
取り込み: 広告 6 行 / ディール 9 行（重複除去前）、重複除去 1 件。

| campaign | impressions | clicks | cost | leads | wonDeals | wonAmount | CPA | ROAS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| always-on | 55,000 | 550 | ¥110,000 | 2 | 0 | ¥0 | ¥10,000 | 0.0% |
| spring-booth | 150,000 | 3,000 | ¥450,000 | 3 | 3 | ¥4,500,000 | ¥7,500 | 1000.0% |
| summer-seminar | 60,000 | 1,200 | ¥180,000 | 1 | 1 | ¥600,000 | ¥10,000 | 333.3% |
| 合計 | 265,000 | 4,750 | ¥740,000 | 6 | 4 | ¥5,100,000 | ¥8,315 | 689.2% |

#### 前月比

| campaign | cost 前月比 | conversions 前月比 | wonAmount 前月比 | ROAS 前月比 |
|---|---:|---:|---:|---:|
| always-on | 10.0% | 10.0% | - | - |
| spring-booth | 25.0% | 25.0% | 87.5% | 50.0% |
| summer-seminar | -25.0% | -43.8% | -33.3% | -11.1% |

前月比は (当月 − 前月) / 前月。前月が0または不明なら -。ROASは受注額 / 広告費を百分率で表示。
広告側にないキャンペーン: なし。
入力: 広告管理ツールのキャンペーン別CSVエクスポート（フィクスチャで再現） / HubSpotのディールCSVエクスポート（フィクスチャで再現）。

## 削減効果

| 項目 | 値 |
|---|---:|
| 手作業 | 145分 |
| 自動化後の人手（想定） | 29分 |
| 機械 | 0.001分 |
| 人手 + 機械 | 29.001分 |
| 削減 | 115.999分（80.0%） |
| 月間換算 | 463.998分 / ¥30,933 |
| 回収 | 2回 |

未実測の項目は -。人手 + 機械を自動化後の時間として削減効果を計算する。

## 手作業ステップの内訳

| id | ステップ | 手作業(分) | 自動化後の人手(分) | 前提 | 自動化の方法 |
|---|---|---:|---:|---|---|
| export-ad | 広告管理ツールからキャンペーン別CSVを書き出す | 5 | 1 | assumed | ファイル配置のみ（取り込み） |
| export-hubspot | HubSpotからディールCSVを書き出す | 5 | 1 | assumed | ファイル配置のみ（取り込み） |
| clean-ad | 広告CSVの不要列削除・日付整形 | 15 | 0 | assumed | parseCsv + normalizeAdRows |
| clean-hubspot | HubSpot CSVのステージ名寄せ・重複除去 | 15 | 0 | assumed | normalizeStage + deal_id 重複除去 |
| join | キャンペーン名で広告とディールを突合 | 20 | 0 | assumed | buildReport の merge |
| calc | CPA/ROAS/リード単価を計算 | 15 | 0 | assumed | metricsFor |
| chart | 前月比を含む集計表を作る | 20 | 0 | assumed | monthOverMonth |
| narrative | 所感・考察の文章を書く | 25 | 25 | assumed | 未自動化（ChatGPTレーンは未実測のため本計測に含めない） |
| format | レポートに整形（表・体裁） | 15 | 0 | assumed | renderReportMarkdown |
| distribute | 共有用に書き出して配布 | 10 | 2 | assumed | out ディレクトリへの書き出し（配布自体は未検証） |

## 前提値（assumed）

- reportsPerMonth: 4（assumed）
- hourlyRateJpy: 4000（assumed）
- implementationMinutes: 180（assumed）

## 未検証

- 手作業分の前提は実測ではなく想定値。
- 所感の文章生成（ChatGPTレーン）は未自動化・未実測。
- HubSpot・広告管理ツールは実APIではなくCSVエクスポートの再現。
- 配布工程は未検証。
- 金額換算は時給の想定値。
- 前提または自動化が未検証のステップ: export-ad, export-hubspot, clean-ad, clean-hubspot, join, calc, chart, narrative, format, distribute。

## 出典

- カタログ: `tools/report-automation-catalog.json`。
- 広告フィクスチャ: `tools/report-automation/fixtures/ad-metrics.csv`。
- HubSpotフィクスチャ: `tools/report-automation/fixtures/hubspot-deals.csv`。
- 実測結果: `tools/report-automation.results.json`。
- 計測日時: 2026-09-24T19:35:40.928Z（`tools/report-automation.results.json` の `runs[].t`、最新run）。
