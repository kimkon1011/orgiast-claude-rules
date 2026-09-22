# 低価格ハードウェア上の音声制御ローカルLLM導入 ルート比較（P-0136）

> このファイルは生成物。手で編集しない。再生成: node tools/voice-local-llm-plan.mjs --write

## 結論

- 推奨: ミニPC（N100級）＋ ローカルLLM（minipc-local）。算出可能な候補の純効果が最大（10,300円/月、年間123,600円）。月額1,200円、削減4h/月、回収期間: 12.43か月。
- この推奨は仮定値に依存する（仮定: opsPerMonth, manualMinutesPerOp, hourlyYen, cloudYenPerOp, devDayYen, minipc-local.residualMinutesPerOp, minipc-local.gadgetYen, minipc-local.buildDays, minipc-local.powerYenPerMonth）。
- 推奨は「提案の必須要件（音声制御かつローカルLLM）を満たす」かつ「見積必須でない」かつ「算出可能」な候補のうち純効果が最大のもの。要件を満たさないルート（ESP32-P4単体・クラウド音声API等）は純効果が最大でも推奨にしない。
- 必須要件（音声制御かつローカルLLM）を満たさないため推奨対象外: ESP32-P4 単体（オンデバイスLLM）（esp32-p4-standalone）＝ESP32-P4 は SRAM 768KB・PSRAM 最大32MB で、日本語の実用対話に耐えるLLMが載らない。LLMはLAN内ホストに置くしかなく、単体構成は『ローカルLLM』の必須要件を満たさない（認識後の処理はクラウドに落ちるため台帳の localLLM は false）。、クラウド音声API（現行延長・ローカルLLMなし）（cloud-voice-api）＝クラウドLLMをそのまま使うため、提案が目的とする『クラウドAPI呼び出しの削減』がゼロ。必須要件（ローカルLLM）を満たさない。、ESP32音声サテライト＋クラウドLLM（ローカルLLMなし）（esp32-cloud-bridge）＝音声前端は安価なESP32で満たすが、LLMはクラウドのままなのでクラウドAPI呼び出しは減らない。必須要件（ローカルLLM）を満たさない。

## ルート比較

価格は台帳の2026-09-23時点の確認区分に従う。金額・時間・回収期間は仮定に基づく試算であり、実測ではない。null は見積必須として伝播する。機能の有無も台帳記載であり、稼働検証結果ではない。

| ルート | 初期費用 | 月額 | 削減h/月 | 削減額円/月 | クラウドAPI削減円/月 | 純効果円/月 | 回収期間 | 価格の確度 | 音声制御 | ローカルLLM |
|---|---:|---:|---:|---:|---:|---:|---|---|---|---|
| ESP32音声サテライト＋既存PC上のローカルLLM（esp32-satellite-local） | 128,000 | 200 | 3.5 | 8,750 | 1,500 | 10,050 | 12.74か月 | 仮定値 | あり（台帳） | あり（台帳） |
| ESP32-P4 単体（オンデバイスLLM）（esp32-p4-standalone） | 212,000 | 1,600 | 1 | 2,500 | 0 | 900 | 235.56か月 | 仮定値 | あり（台帳） | なし（台帳） |
| Raspberry Pi 5 ＋ whisper.cpp ＋ llama.cpp（完全ローカル）（rpi5-local） | 180,000 | 400 | 3.25 | 8,125 | 1,500 | 9,225 | 19.51か月 | 仮定値 | あり（台帳） | あり（台帳） |
| ミニPC（N100級）＋ ローカルLLM（minipc-local） | 128,000 | 1,200 | 4 | 10,000 | 1,500 | 10,300 | 12.43か月 | 仮定値 | あり（台帳） | あり（台帳） |
| クラウド音声API（現行延長・ローカルLLMなし）（cloud-voice-api） | 40,000 | 1,500 | 3.75 | 9,375 | 0 | 7,875 | 5.08か月 | 二次情報。公式で要再確認 | あり（台帳） | なし（台帳） |
| ESP32音声サテライト＋クラウドLLM（ローカルLLMなし）（esp32-cloud-bridge） | 88,000 | 1,700 | 3.75 | 9,375 | 0 | 7,675 | 11.47か月 | 仮定値 | あり（台帳） | なし（台帳） |

- ESP32音声サテライト＋既存PC上のローカルLLM（esp32-satellite-local）: ESP32ボード＋マイク＋スピーカーで8,000円は仮定値。実売は未確認。ホストは既存PCを流用する前提で、その費用は計上していない。 残作業: 0.6分/件（仮定）。ウェイクワード誤検出と言い直しの訂正（0.6分/件と仮定）。
- ESP32-P4 単体（オンデバイスLLM）（esp32-p4-standalone）: ESP32-P4 評価ボード＋周辺で12,000円は仮定値。実売は未確認。 残作業: 1.6分/件（仮定）。実用モデルが載らないため認識後の処理はクラウドへ落ち、聞き取り直しが頻発する前提（1.6分/件と仮定）。
- Raspberry Pi 5 ＋ whisper.cpp ＋ llama.cpp（完全ローカル）（rpi5-local）: Pi 5 8GB＋ケース＋電源＋ストレージ＋マイクで20,000円は仮定値。為替・品薄で変動するため発注前に実売の確認が必要。 残作業: 0.7分/件（仮定）。推論待ちと言い直しの訂正（0.7分/件と仮定）。
- ミニPC（N100級）＋ ローカルLLM（minipc-local）: ミニPC 45,000円＋マイク・スピーカー3,000円で48,000円は仮定値。実売は未確認。 残作業: 0.4分/件（仮定）。ホスト性能が高く待ち時間と訂正が小さい前提（0.4分/件と仮定）。
- クラウド音声API（現行延長・ローカルLLMなし）（cloud-voice-api）: 公式は音声トークン/分単位の従量。1操作あたり10円への換算は仮定。実額は操作の長さに依存する。 残作業: 0.5分/件（仮定）。認識誤りの訂正（0.5分/件と仮定）。
- ESP32音声サテライト＋クラウドLLM（ローカルLLMなし）（esp32-cloud-bridge）: ESP32ボード＋マイク＋スピーカーで8,000円は仮定値。LLMはクラウドのため従量が別途かかる。 残作業: 0.5分/件（仮定）。認識誤りの訂正（0.5分/件と仮定）。

## 感度分析

| ルート | 50操作/月 | 100操作/月 | 200操作/月 | 400操作/月 |
|---|---:|---:|---:|---:|
| ESP32音声サテライト＋既存PC上のローカルLLM（esp32-satellite-local） | 3,217 | 6,633 | 13,467 | 27,133 |
| ESP32-P4 単体（オンデバイスLLM）（esp32-p4-standalone） | 233 | 567 | 1,233 | 2,567 |
| Raspberry Pi 5 ＋ whisper.cpp ＋ llama.cpp（完全ローカル）（rpi5-local） | 2,808 | 6,017 | 12,433 | 25,267 |
| ミニPC（N100級）＋ ローカルLLM（minipc-local） | 2,633 | 6,467 | 14,133 | 29,467 |
| クラウド音声API（現行延長・ローカルLLMなし）（cloud-voice-api） | 2,625 | 5,250 | 10,500 | 21,000 |
| ESP32音声サテライト＋クラウドLLM（ローカルLLMなし）（esp32-cloud-bridge） | 2,425 | 5,050 | 10,300 | 20,800 |

純効果円/月の試算。操作件数（opsPerMonth）・手作業と残作業の時間差・人件費単価の仮定が削減額を支配し、クラウド単価がAPI削減額と月額を左右する（実測ではない）。

## 音声サテライト＋ローカルLLMホストの実装スケッチ

- ESP32 側はウェイクワード検出と音声区間検出だけを担い、認識済み音声（または生PCM）をLAN内ホストへ送る。LLMはESP32に載せない。
- ホスト側で whisper.cpp 等のASR → llama.cpp 等のLLM → 応答音声の順に処理し、応答だけをESP32へ返す。
- ホストは既存PCの常時稼働を第一候補にし、無い場合のみミニPCを追加する。ホストの有無で初期費用が変わることを台帳に明記する。
- 誤認識と言い直しの訂正回数をログに残し、residualMinutesPerOp の仮定を実測で置き換える。
- 応答までの時間を「音声区間検出＋ASR＋推論＋音声合成」に分解して計測する。体感速度は推論だけで決まらない。
- 電源断・LAN断のときにクラウドへ自動フォールバックするかは方針として決める（フォールバックするならクラウド従量は0にならない）。

## 前提（仮定であり実測ではない）

| 項目 | 値（仮定） | 注記 |
|---|---:|---|
| opsPerMonth | 150 | 音声で操作したい件数150件/月は仮定。当社の実測は未取得（--ops で上書き可）。 |
| manualMinutesPerOp | 2 | 現状は手作業で2分/件かかると仮定。内訳の実測は未取得。 |
| hourlyYen | 2,500 | 社内単価2,500円/hは仮定。--hourly-yen で実際の人件費単価に上書きすること。 |
| cloudYenPerOp | 10 | クラウド音声APIの1操作あたり10円は仮定。公式は音声トークン/分単位の従量で、1操作あたりへの換算は仮定に依存する。**この値がクラウドAPI削減額と結論を支配する**（--cloud-yen-per-op で上書き可）。 |
| devDayYen | 40,000 | 立上げ人日単価40,000円/日は仮定。マイコン側ファームと音声前端の作り込み工数を含む。 |

- 表の値が今回の試算入力。注記の既定値と異なる場合はCLI上書き値を使用している。--cloud-yen-per-op はクラウドルートの従量とローカルLLMルートのクラウドAPI削減額に適用する。未取得のnullは0と解釈しない。

## 見積必須・未確認

- localShiftIsNotCostDriven: 低件数ではクラウド音声APIの従量がローカル構築の初期費用を下回る。ローカル化の根拠はコストではなくオフライン動作・データを社外に出さないこと・ベンダー依存の回避に置くべき（unverified）。クラウドAPI削減額は opsPerMonth × cloudYenPerOp で、150件/月・10円/件なら1,500円/月にしかならない。初期費用12万円台の回収は主に工数削減側で賄われる。件数が小さいほどローカル化の経済的優位は消える。
- latencyIsHostBound: 応答速度はローカルLLMを動かすホストの性能とLANに律速され、ESP32は音声入出力の前端にすぎない（unverified）。『ESP32を載せれば速くなる』は誤り。速度改善幅はホストのCPU/GPUと音声区間検出の実装に依存し、未実測。
- asrQualityDecidesUsability: 日本語ASRの精度と誤認識訂正の手間が実用性を決める。ウェイクワード検出（ESP32側）と ASR/LLM（ホスト側）は別物（unverified）。residualMinutesPerOp は誤認識訂正・言い直しの残作業を表す仮定値。ここが大きいと音声化の効果は消える。

## 出典

- esp32p4: https://www.espressif.com/en/products/socs/esp32-p4
- raspberryPi5: https://www.raspberrypi.com/products/raspberry-pi-5/
- openaiPricing: https://openai.com/api/pricing/
- whisperCpp: https://github.com/ggml-org/whisper.cpp
- llamaCpp: https://github.com/ggml-org/llama.cpp
- ESP32音声サテライト＋既存PC上のローカルLLM（esp32-satellite-local）: https://www.espressif.com/en/products/socs/esp32-p4
- ESP32-P4 単体（オンデバイスLLM）（esp32-p4-standalone）: https://www.espressif.com/en/products/socs/esp32-p4
- Raspberry Pi 5 ＋ whisper.cpp ＋ llama.cpp（完全ローカル）（rpi5-local）: https://www.raspberrypi.com/products/raspberry-pi-5/
- ミニPC（N100級）＋ ローカルLLM（minipc-local）: https://github.com/ggml-org/llama.cpp
- クラウド音声API（現行延長・ローカルLLMなし）（cloud-voice-api）: https://openai.com/api/pricing/
- ESP32音声サテライト＋クラウドLLM（ローカルLLMなし）（esp32-cloud-bridge）: https://www.espressif.com/en/products/socs/esp32-p4
