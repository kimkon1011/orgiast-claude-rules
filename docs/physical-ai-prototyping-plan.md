# フィジカルAIを活用したプロトタイプ高速化 ルート比較（P-0137）

> このファイルは生成物。手で編集しない。再生成: node tools/physical-ai-prototyping-plan.mjs --write

## 結論

- 推奨: SO-101（LeRobot）自前調達＋模倣学習（so101-diy）。算出可能な候補の純効果が最大（269,417円/月、年間3,233,000円）。月額1,917円、短縮220分/件、回収期間: 0.53か月。
- この推奨は仮定値に依存する（仮定: prototypesPerMonth, currentLeadDays, currentManualMinutesPerPrototype, hourlyYen, devDayYen, marginYenPerPrototype, demandCaptureRate, amortizeMonths, so101-diy.residualMinutesPerPrototype）。
- 推奨は「提案の必須要件（物理AIかつ試作サイクル短縮）を満たす」かつ「見積必須でない」かつ「算出可能」な候補のうち純効果が最大のもの。要件を満たさないルート（例: 3Dプリンタ＋AIスライサは物理AIではない）は純効果が最大でも推奨にしない。

- demandCaptureRate による追加受注への転換が売上効果の唯一の原資。追加試作能力 × marginYenPerPrototype × demandCaptureRate で粗利換算し、0なら売上効果は0、効果は工数削減のみ（純効果はそこから月額費用を差し引く）。nullなら売上効果・純効果は算出しない。

## ルート比較

価格は台帳の2026-09-23時点の確認区分に従う。金額・時間・回収期間は仮定に基づく試算であり、実測ではない。null は見積必須として伝播する。機能の有無も台帳記載であり、稼働検証結果ではない。

| ルート | 初期費用 | 月額 | 短縮分/件 | 工数削減円/月 | 売上効果円/月 | 純効果円/月 | 回収期間 | 価格の確度 | 物理AI | 試作短縮 |
|---|---:|---:|---:|---:|---:|---:|---|---|---|---|
| SO-101（LeRobot）自前調達＋模倣学習（so101-diy） | 142,000 | 1,917 | 220 | 36,667 | 234,667 | 269,417 | 0.53か月 | 二次情報。公式で要再確認 | あり（台帳） | あり（台帳） |
| SO-ARM101 Pro 組立済キット（Seeed）＋LeRobot（so101-kit） | 85,000 | 2,875 | 225 | 37,500 | 234,667 | 269,292 | 0.32か月 | 二次情報。公式で要再確認 | あり（台帳） | あり（台帳） |
| エッジAIカメラ（XIAO ESP32S3 Sense 等）＋外観検査（edge-vision） | 88,000 | 333 | 180 | 30,000 | 25,600 | 55,267 | 1.59か月 | 仮定値 | あり（台帳） | あり（台帳） |
| Bambu Lab A1 mini ＋ AIスライサ／CAD生成（fdm-printer） | 69,800 | 4,242 | 150 | 25,000 | 115,200 | 135,958 | 0.51か月 | 二次情報。公式で要再確認 | なし（台帳） | あり（台帳） |

- SO-101（LeRobot）自前調達＋模倣学習（so101-diy）: サーボ・電子部品の自前調達で100〜200ドル相当（円換算2.2万円と仮定）。構造部品は自前3Dプリント。為替・関税で変動するため発注前に要確認。 残作業: 20分/件（仮定）。テレオペ教示と学習データ収集が残る（20分/件と仮定）。
- SO-ARM101 Pro 組立済キット（Seeed）＋LeRobot（so101-kit）: Pro Kit 299ドル、サーボのみ189ドル。円換算4.5万円と仮定。組立工数はほぼ無い。予算枠（1〜2万円）を超える。 残作業: 15分/件（仮定）。教示（15分/件と仮定）。組立済のため立上げは短い。
- エッジAIカメラ（XIAO ESP32S3 Sense 等）＋外観検査（edge-vision）: 実売価格は未確認。8,000円は仮定値。発注前に実売・見積の確認が必要。 残作業: 60分/件（仮定）。検査モデルの学習と判定確認が残る（60分/件と仮定）。短縮できるのは検査工程に限られる。
- Bambu Lab A1 mini ＋ AIスライサ／CAD生成（fdm-printer）: 公式日本ストア 29,800円（AMS Lite 付は52,800円）。セールで29,900円前後。 残作業: 90分/件（仮定）。造形後の後処理と寸法確認（90分/件と仮定）。

## 感度分析

| ルート | 1件/月 | 2件/月 | 4件/月 | 8件/月 | 12件/月 |
|---|---:|---:|---:|---:|---:|
| SO-101（LeRobot）自前調達＋模倣学習（so101-diy） | 65,917 | 133,750 | 269,417 | 540,750 | 812,083 |
| SO-ARM101 Pro 組立済キット（Seeed）＋LeRobot（so101-kit） | 65,167 | 133,208 | 269,292 | 541,458 | 813,625 |
| エッジAIカメラ（XIAO ESP32S3 Sense 等）＋外観検査（edge-vision） | 13,567 | 27,467 | 55,267 | 110,867 | 166,467 |
| Bambu Lab A1 mini ＋ AIスライサ／CAD生成（fdm-printer） | 30,808 | 65,858 | 135,958 | 276,158 | 416,358 |

純効果円/月の試算。件数・手作業と残作業の時間差・人件費単価が工数削減額を、リードタイム・追加試作1件の粗利・需要転換率が売上効果を左右する（実測ではない）。

## 模倣学習の実装スケッチ

- リーダーアームでテレオペ教示し、LeRobot のデータセット形式でエピソードを記録する。
- カメラはワークスペースを俯瞰する固定位置に置き、照明条件を固定する。
- ACT 等の模倣学習ポリシーを学習し、成功判定は試作タスクの完了条件（はめ合い・位置決め等）で自動判定する。
- 失敗エピソードを追加収集して再学習するループを回し、成功率と1件あたり所要時間を記録する。
- 教示・学習・推論のログを Sheets に残し、`residualMinutesPerPrototype` の実測値で仮定を置き換える。

## 前提（仮定であり実測ではない）

| 項目 | 値（仮定） | 注記 |
|---|---:|---|
| prototypesPerMonth | 4 | 当社の月間試作件数の実測値は未取得。4件/月は仮定（--prototypes で上書き可）。 |
| currentLeadDays | 14 | 現状の試作リードタイム14日は仮定。案件ごとの実測（発注日→検収日）が必要。 |
| currentManualMinutesPerPrototype | 240 | 現状の手作業240分/件（4h）は仮定。内訳の実測は未取得。 |
| hourlyYen | 2,500 | 社内単価2,500円/hは仮定。--hourly-yen で実際の人件費単価に上書きすること。 |
| devDayYen | 40,000 | 立上げ人日単価40,000円/日は仮定。 |
| marginYenPerPrototype | 80,000 | 試作1件が生む粗利80,000円は仮定。ここが売上効果の唯一の原資であり、実測が必要。 |
| demandCaptureRate | 0.2 | 短縮で空いた能力が実際に追加受注へ転換する割合。0.2は仮定。**ここが0なら売上増加は0で、効果は工数削減のみ**になる。需要は無限ではない。 |
| amortizeMonths | 24 | ガジェット代の月割り期間24か月は仮定。 |

- 表の値が今回の試算入力。注記の既定値と異なる場合はCLI上書き値を使用している。未取得のnullは0で補完しない。

## 見積必須・未確認

- budgetBandFit: 1万〜2万円の枠に収まるのは自前調達のSO-101（Feetech STS3215サーボ＋自前3Dプリント）構成のみ。組立済キットは189〜299ドルで枠を超える（unverified）。為替・関税・送料で円換算は変動する。発注前に実売価格の確認が必要。
- leadTimeIsNotDemand: 試作リードタイムの短縮は受注増を意味しない（需要が上限）（unverified）。売上増加は『短縮で空いた能力が受注に転換する』という追加仮定に依存する。demandCaptureRate で明示し、0にすると売上効果が消える。
- imitationLearningNeedsHuman: 模倣学習はテレオペ教示という人手を必要とし、工数削減が小さい可能性がある（unverified）。教示の1回あたり時間と必要エピソード数は未実測。residualMinutesPerPrototype に反映している。

## 出典

- so101Price: https://www.roboticscenter.ai/hardware/so-101
- soArm101SeeedPdf: https://files.seeedstudio.com/Bazaar/product_pdf/100046482.pdf
- bambuA1MiniJp: https://jp.store.bambulab.com/products/a1-mini
- lerobot: https://github.com/huggingface/lerobot
- xiaoEsp32s3Sense: https://wiki.seeedstudio.com/xiao_esp32s3_camera_usage/
- SO-101（LeRobot）自前調達＋模倣学習（so101-diy）: https://www.roboticscenter.ai/hardware/so-101
- SO-ARM101 Pro 組立済キット（Seeed）＋LeRobot（so101-kit）: https://files.seeedstudio.com/Bazaar/product_pdf/100046482.pdf
- エッジAIカメラ（XIAO ESP32S3 Sense 等）＋外観検査（edge-vision）: https://wiki.seeedstudio.com/xiao_esp32s3_camera_usage/
- Bambu Lab A1 mini ＋ AIスライサ／CAD生成（fdm-printer）: https://jp.store.bambulab.com/products/a1-mini
