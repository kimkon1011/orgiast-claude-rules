# レシート自動入力とカレンダー連携ツールの導入 ルート比較（P-0135）

> このファイルは生成物。手で編集しない。再生成: node tools/receipt-automation-plan.mjs --write

## 結論

- 推奨: 自前実装（既存GAS基盤＋Drive＋LLM OCR＋CalendarApp）（diy-gas）。算出可能な候補の純効果が最大（32,733円/月、年間392,800円）。月額600円、削減13.33h/月、回収期間: 6.11か月。
- この推奨は仮定値に依存する（仮定: casesPerMonth, manualMinutesPerCase, reconcileMinutesPerCase, hourlyYen, llmYenPerCase, devDayYen, diy-gas.residualMinutesPerCase, diy-gas.fixedYen, diy-gas.licenseYenPerMonth, diy-gas.includedCasesPerMonth, diy-gas.overageYenPerCase, diy-gas.llmYenPerCase, diy-gas.devDays）。
- 推奨は「提案の必須要件（レシート→PDF作成かつカレンダー照合）を満たす」かつ「見積必須でない」かつ「算出可能」な候補のうち純効果が最大のもの。要件を満たさないルート（例: 会計SaaS内蔵OCRはカレンダー照合もPDF作成も持たない）は純効果が最大でも推奨にしない。

## ルート比較

価格は台帳の2026-09-23時点の確認区分に従う。金額・時間・回収期間は仮定に基づく試算であり、実測ではない。null は見積必須として伝播する。機能の有無も台帳記載であり、稼働検証結果ではない。

| ルート | 初期費用 | 月額 | 削減h/月 | 削減額円/月 | 純効果円/月 | 回収期間 | 価格の確度 | カレンダー照合 | レシート→PDF |
|---|---:|---:|---:|---:|---:|---|---|---|---|
| マネーフォワード クラウド会計（AI-OCR内蔵）（mf-cloud） | 0 | 7,280 | 14.33 | 35,833 | 28,553 | 初期費用0円のため即時 | 二次情報。公式で要再確認 | なし（台帳） | なし（台帳） |
| freee会計（法人プラン）（freee-corporate） | 見積必須 | 見積必須 | 14.33 | 35,833 | 見積必須 | 見積必須 | 公開価格なし。見積必須 | なし（台帳） | なし（台帳） |
| SAP Concur Expense（ExpenseIt／経費自動化エージェント）（sap-concur） | 見積必須 | 見積必須 | 15 | 37,500 | 見積必須 | 見積必須 | 公開価格なし。見積必須 | あり（台帳） | なし（台帳） |
| 汎用RPA（Power Automate Desktop／UiPath／WinActor 等）＋ AI-OCR（rpa-generic） | 見積必須 | 見積必須 | 13.33 | 33,333 | 見積必須 | 見積必須 | 公開価格なし。見積必須 | あり（台帳） | あり（台帳） |
| 自前実装（既存GAS基盤＋Drive＋LLM OCR＋CalendarApp）（diy-gas） | 200,000 | 600 | 13.33 | 33,333 | 32,733 | 6.11か月 | 仮定値 | あり（台帳） | あり（台帳） |

- マネーフォワード クラウド会計（AI-OCR内蔵）（mf-cloud）: 法人スモールビジネス 年払4,480円/月（税抜・3名まで）。検索結果間で税込表記・金額の相違があるため契約前に公式で要確認。 残作業: 1.2分/件（仮定）。OCR＋AI仕訳提案の確認のみと仮定（1.2分/件）。
- freee会計（法人プラン）（freee-corporate）: 法人プランは公開価格を一次情報で確認できなかった。見積・資料請求が必要。 残作業: 1.2分/件（仮定）。未確認。MFと同等という仮定で比較表に載せる。
- SAP Concur Expense（ExpenseIt／経費自動化エージェント）（sap-concur）: 公開価格なし。導入は販売パートナー経由の見積のみ。Joule Premium が一部機能の前提。 残作業: 1分/件（仮定）。出張行程と領収書の突合まで自動化される想定（1分/件）。未確認。
- 汎用RPA（Power Automate Desktop／UiPath／WinActor 等）＋ AI-OCR（rpa-generic）: ライセンス形態（同時実行／named）で価格が大きく変わり、公開価格を一次情報で確認できなかった。初期費用も見積必須。 残作業: 1.5分/件（仮定）。OCR済みデータの確認と例外処理（1.5分/件）と仮定。
- 自前実装（既存GAS基盤＋Drive＋LLM OCR＋CalendarApp）（diy-gas）: ライセンス追加0円。LLM API従量のみで、単価は仮定値（assumptions.llmYenPerCase）。無料枠という概念が無く超過課金も無いため、無料枠0件・超過0円/件として扱う（従量課金の合計は0円）。 残作業: 1.5分/件（仮定）。生成物の目視確認（1.5分/件）と仮定。会計SaaSへの転記は別途。

## 感度分析

| ルート | 50件/月 | 100件/月 | 200件/月 | 400件/月 |
|---|---:|---:|---:|---:|
| マネーフォワード クラウド会計（AI-OCR内蔵）（mf-cloud） | 4,478 | 12,637 | 28,553 | 60,387 |
| freee会計（法人プラン）（freee-corporate） | - | - | - | - |
| SAP Concur Expense（ExpenseIt／経費自動化エージェント）（sap-concur） | - | - | - | - |
| 汎用RPA（Power Automate Desktop／UiPath／WinActor 等）＋ AI-OCR（rpa-generic） | - | - | - | - |
| 自前実装（既存GAS基盤＋Drive＋LLM OCR＋CalendarApp）（diy-gas） | 8,183 | 16,367 | 32,733 | 65,467 |

純効果円/月の試算。件数・手作業と残作業の時間差・人件費単価の仮定が削減額を支配し、無料枠超過単価とLLM単価が月額を左右する（実測ではない）。

## カレンダー照合の実装スケッチ

- GASで対象カレンダーと期間・タイムゾーンを指定し、CalendarAppから予定を取得する。
- DriveのレシートをOCRし、日付・金額・通貨を抽出して原本への参照を保持する。
- 予定の説明欄または案件台帳から案件ID・照合用金額を取得する。予定に金額がなければ要確認とする。
- レシートの日付×金額で予定を突合する。一意に一致した候補を案件に紐付け、複数候補・不一致は人が確認する。
- 確認結果をSheets等に保存し、レシート→PDFと案件の参照を記録する。重複登録を防ぎ、試行時に一致率・残作業時間を実測する。

## 前提（仮定であり実測ではない）

| 項目 | 値（仮定） | 注記 |
|---|---:|---|
| casesPerMonth | 200 | 当社の月間レシート/領収書件数の実測値は未取得。200件/月は仮定（--cases で上書き可）。 |
| manualMinutesPerCase | 4 | 手入力4分/件は仮定。実測には経理担当へのタイムスタディが必要。 |
| reconcileMinutesPerCase | 1.5 | カレンダー（出張・来場予定）との突き合わせ1.5分/件は仮定。 |
| hourlyYen | 2,500 | 社内単価2,500円/hは仮定。実際の経理担当の人件費単価で --hourly-yen により上書きすること。 |
| llmYenPerCase | 3 | 自前ルートのLLM API従量費3円/件は仮定。モデル単価の台帳（tools/*-catalog.json）から実測値に置き換えるまで確定値として扱わない。 |
| devDayYen | 40,000 | 自前実装の人日単価40,000円/日は仮定。 |

- 表の値が今回の試算入力。注記の既定値と異なる場合はCLI上書き値を使用している。--llm-yen-per-case は自前（kind=diy）の既知LLM単価に適用し、未取得のnullは補完しない。

## 見積必須・未確認

- freee会計（法人プラン）（freee-corporate）: 見積必須。法人プランは公開価格を一次情報で確認できなかった。見積・資料請求が必要。
- SAP Concur Expense（ExpenseIt／経費自動化エージェント）（sap-concur）: 見積必須。公開価格なし。導入は販売パートナー経由の見積のみ。Joule Premium が一部機能の前提。
- 汎用RPA（Power Automate Desktop／UiPath／WinActor 等）＋ AI-OCR（rpa-generic）: 見積必須。ライセンス形態（同時実行／named）で価格が大きく変わり、公開価格を一次情報で確認できなかった。初期費用も見積必須。
- conqurProductIdentity: 「Conqur」という名称の製品は一次情報で確認できなかった（unverified）。提案文の『Conqur等のRPA』は SAP Concur の誤記と推定される。導入前に製品名の確定が必要。
- manualTimeMeasured: false（unverified）。当社の経費精算・レシート入力の工数実測値は未取得。
- rpaPersonalAccountRisk: 汎用RPAを個人アカウントのUI操作に常用すると、規約違反・アカウント停止のリスクがある（unverified）。ベンダー規約の確認が前提。法人契約と自動化対象の明示が必要。

## 出典

- mfPrice: https://biz.moneyforward.com/price/
- mfPlanDetail: https://biz.moneyforward.com/price/detail/
- freeeCorporate: https://www.freee.co.jp/pricing/
- concurJapan: https://www.concur.co.jp/
- concurExpenseIt: https://help.sap.com/docs/SAP_CONCUR
- fastaccountingRobota: https://fastaccounting.ai/service/tracing-receipts/
- gasCalendar: https://developers.google.com/apps-script/reference/calendar/calendar-app
- gasDriveOcr: https://developers.google.com/apps-script/reference/drive/drive-app
- マネーフォワード クラウド会計（AI-OCR内蔵）（mf-cloud）: https://biz.moneyforward.com/price/
- freee会計（法人プラン）（freee-corporate）: https://www.freee.co.jp/pricing/
- SAP Concur Expense（ExpenseIt／経費自動化エージェント）（sap-concur）: https://www.concur.co.jp/
- 汎用RPA（Power Automate Desktop／UiPath／WinActor 等）＋ AI-OCR（rpa-generic）: https://www.concur.co.jp/
- 自前実装（既存GAS基盤＋Drive＋LLM OCR＋CalendarApp）（diy-gas）: https://developers.google.com/apps-script/reference/calendar/calendar-app
