# 16GB Mac ローカルLLM実行可能性・ベンチマーク見積り（P-0120）

> このファイルは生成物。手で編集しない。再生成: `node tools/mac-16gb-plan.mjs --write`
> 台帳: `tools/mac-16gb-catalog.json`（更新: 2026-09-20）
> 出典区分: `primary`=一次情報で確認 / `media`=報道または既存台帳 / `assumed`=前提値 / `unknown`=未取得
> **tok/s・価格は推定または取得時点の値であり、実機での性能・現在の実売価格を断定するものではない。**

## 結論

- 16GB Macでは、この前提下でQ4_K_Mの 5 モデルが文脈を短縮すれば収容可能。特にQwen3-1.7BとQwen2.5-3B-Instructは軽量なため実用候補である。
- 既に手元に16GB Macがあり、下表の推定tok/sと最大文脈で足りる分類・抽出・要約・オフライン処理なら、P-0114の94.98万円〜のMac Studioを買わずに済む可能性がある。これは理論見積りであり、購入判断前に実測が必要。
- 長文脈や8B以上、フロンティアモデル相当の品質が必要な用途の代替とはみなさない。新品購入では、モデル品質・必要文脈・実測速度とクラウド費用を比較してから判断する。

## 16GBで動く構成の一覧

| 機種 | モデル | 量子化 | 最大文脈token | ネイティブ文脈 | 推定tok/s帯 |
|---|---|---|---:|---|---:|
| Mac mini (M4) 16GB/256GB | Qwen3-1.7B | Q4_K_M (4bit相当) | 25,094 | 収まらない | 64.7–88.2（推定） |
| Mac mini (M4) 16GB/256GB | Qwen3-1.7B | Q8_0 (8bit相当) | 17,553 | 収まらない | 36.5–49.8（推定） |
| Mac mini (M4) 16GB/256GB | Qwen3-1.7B | F16 (無圧縮) | 2,267 | 収まらない | 19.4–26.5（推定） |
| Mac mini (M4) 16GB/256GB | Qwen3-4B | Q4_K_M (4bit相当) | 9,223 | 収まらない | 27.5–37.5（推定） |
| Mac mini (M4) 16GB/256GB | Qwen2.5-3B-Instruct | Q4_K_M (4bit相当) | 32,768 | 収まる | 36.7–50.0（推定） |
| Mac mini (M4) 16GB/256GB | Qwen2.5-3B-Instruct | Q8_0 (8bit相当) | 13,393 | 収まらない | 20.7–28.2（推定） |
| Mac mini (M4) 16GB/256GB | Llama-3.2-3B-Instruct | Q4_K_M (4bit相当) | 17,613 | 収まらない | 36.7–50.0（推定） |
| Mac mini (M4) 16GB/256GB | Llama-3.2-3B-Instruct | Q8_0 (8bit相当) | 4,305 | 収まらない | 20.7–28.2（推定） |
| Mac mini (M4) 16GB/256GB | Phi-4-mini-instruct | Q4_K_M (4bit相当) | 11,383 | 収まらない | 28.9–39.5（推定） |
| Mac mini (M6) 16GB/256GB | Qwen3-1.7B | Q4_K_M (4bit相当) | 25,094 | 収まらない | 91.7–125.0（推定） |
| Mac mini (M6) 16GB/256GB | Qwen3-1.7B | Q8_0 (8bit相当) | 17,553 | 収まらない | 51.8–70.6（推定） |
| Mac mini (M6) 16GB/256GB | Qwen3-1.7B | F16 (無圧縮) | 2,267 | 収まらない | 27.5–37.5（推定） |
| Mac mini (M6) 16GB/256GB | Qwen3-4B | Q4_K_M (4bit相当) | 9,223 | 収まらない | 39.0–53.1（推定） |
| Mac mini (M6) 16GB/256GB | Qwen2.5-3B-Instruct | Q4_K_M (4bit相当) | 32,768 | 収まる | 51.9–70.8（推定） |
| Mac mini (M6) 16GB/256GB | Qwen2.5-3B-Instruct | Q8_0 (8bit相当) | 13,393 | 収まらない | 29.3–40.0（推定） |
| Mac mini (M6) 16GB/256GB | Llama-3.2-3B-Instruct | Q4_K_M (4bit相当) | 17,613 | 収まらない | 51.9–70.8（推定） |
| Mac mini (M6) 16GB/256GB | Llama-3.2-3B-Instruct | Q8_0 (8bit相当) | 4,305 | 収まらない | 29.3–40.0（推定） |
| Mac mini (M6) 16GB/256GB | Phi-4-mini-instruct | Q4_K_M (4bit相当) | 11,383 | 収まらない | 41.0–55.9（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-1.7B | Q4_K_M (4bit相当) | 25,094 | 収まらない | 64.7–88.2（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-1.7B | Q8_0 (8bit相当) | 17,553 | 収まらない | 36.5–49.8（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-1.7B | F16 (無圧縮) | 2,267 | 収まらない | 19.4–26.5（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-4B | Q4_K_M (4bit相当) | 9,223 | 収まらない | 27.5–37.5（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen2.5-3B-Instruct | Q4_K_M (4bit相当) | 32,768 | 収まる | 36.7–50.0（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen2.5-3B-Instruct | Q8_0 (8bit相当) | 13,393 | 収まらない | 20.7–28.2（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Llama-3.2-3B-Instruct | Q4_K_M (4bit相当) | 17,613 | 収まらない | 36.7–50.0（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Llama-3.2-3B-Instruct | Q8_0 (8bit相当) | 4,305 | 収まらない | 20.7–28.2（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Phi-4-mini-instruct | Q4_K_M (4bit相当) | 11,383 | 収まらない | 28.9–39.5（推定） |

## 文脈長テーブル

| 機種 | モデル | 量子化 | 最大文脈token | ネイティブで収まるか（computeFit） | 推定tok/s帯 |
|---|---|---|---:|---|---:|
| Mac mini (M4) 16GB/256GB | Qwen3-1.7B | Q4_K_M (4bit相当) | 25,094 | いいえ | 64.7–88.2（推定） |
| Mac mini (M4) 16GB/256GB | Qwen3-1.7B | Q8_0 (8bit相当) | 17,553 | いいえ | 36.5–49.8（推定） |
| Mac mini (M4) 16GB/256GB | Qwen3-1.7B | F16 (無圧縮) | 2,267 | いいえ | 19.4–26.5（推定） |
| Mac mini (M4) 16GB/256GB | Qwen3-4B | Q4_K_M (4bit相当) | 9,223 | いいえ | 27.5–37.5（推定） |
| Mac mini (M4) 16GB/256GB | Qwen3-4B | Q8_0 (8bit相当) | - | いいえ | - |
| Mac mini (M4) 16GB/256GB | Qwen3-4B | F16 (無圧縮) | - | いいえ | - |
| Mac mini (M4) 16GB/256GB | Qwen2.5-3B-Instruct | Q4_K_M (4bit相当) | 32,768 | はい | 36.7–50.0（推定） |
| Mac mini (M4) 16GB/256GB | Qwen2.5-3B-Instruct | Q8_0 (8bit相当) | 13,393 | いいえ | 20.7–28.2（推定） |
| Mac mini (M4) 16GB/256GB | Qwen2.5-3B-Instruct | F16 (無圧縮) | - | いいえ | - |
| Mac mini (M4) 16GB/256GB | Llama-3.2-3B-Instruct | Q4_K_M (4bit相当) | 17,613 | いいえ | 36.7–50.0（推定） |
| Mac mini (M4) 16GB/256GB | Llama-3.2-3B-Instruct | Q8_0 (8bit相当) | 4,305 | いいえ | 20.7–28.2（推定） |
| Mac mini (M4) 16GB/256GB | Llama-3.2-3B-Instruct | F16 (無圧縮) | - | いいえ | - |
| Mac mini (M4) 16GB/256GB | Phi-4-mini-instruct | Q4_K_M (4bit相当) | 11,383 | いいえ | 28.9–39.5（推定） |
| Mac mini (M4) 16GB/256GB | Phi-4-mini-instruct | Q8_0 (8bit相当) | - | いいえ | - |
| Mac mini (M4) 16GB/256GB | Phi-4-mini-instruct | F16 (無圧縮) | - | いいえ | - |
| Mac mini (M4) 16GB/256GB | Qwen3-8B | Q4_K_M (4bit相当) | - | いいえ | - |
| Mac mini (M4) 16GB/256GB | Qwen3-8B | Q8_0 (8bit相当) | - | いいえ | - |
| Mac mini (M4) 16GB/256GB | Qwen3-8B | F16 (無圧縮) | - | いいえ | - |
| Mac mini (M6) 16GB/256GB | Qwen3-1.7B | Q4_K_M (4bit相当) | 25,094 | いいえ | 91.7–125.0（推定） |
| Mac mini (M6) 16GB/256GB | Qwen3-1.7B | Q8_0 (8bit相当) | 17,553 | いいえ | 51.8–70.6（推定） |
| Mac mini (M6) 16GB/256GB | Qwen3-1.7B | F16 (無圧縮) | 2,267 | いいえ | 27.5–37.5（推定） |
| Mac mini (M6) 16GB/256GB | Qwen3-4B | Q4_K_M (4bit相当) | 9,223 | いいえ | 39.0–53.1（推定） |
| Mac mini (M6) 16GB/256GB | Qwen3-4B | Q8_0 (8bit相当) | - | いいえ | - |
| Mac mini (M6) 16GB/256GB | Qwen3-4B | F16 (無圧縮) | - | いいえ | - |
| Mac mini (M6) 16GB/256GB | Qwen2.5-3B-Instruct | Q4_K_M (4bit相当) | 32,768 | はい | 51.9–70.8（推定） |
| Mac mini (M6) 16GB/256GB | Qwen2.5-3B-Instruct | Q8_0 (8bit相当) | 13,393 | いいえ | 29.3–40.0（推定） |
| Mac mini (M6) 16GB/256GB | Qwen2.5-3B-Instruct | F16 (無圧縮) | - | いいえ | - |
| Mac mini (M6) 16GB/256GB | Llama-3.2-3B-Instruct | Q4_K_M (4bit相当) | 17,613 | いいえ | 51.9–70.8（推定） |
| Mac mini (M6) 16GB/256GB | Llama-3.2-3B-Instruct | Q8_0 (8bit相当) | 4,305 | いいえ | 29.3–40.0（推定） |
| Mac mini (M6) 16GB/256GB | Llama-3.2-3B-Instruct | F16 (無圧縮) | - | いいえ | - |
| Mac mini (M6) 16GB/256GB | Phi-4-mini-instruct | Q4_K_M (4bit相当) | 11,383 | いいえ | 41.0–55.9（推定） |
| Mac mini (M6) 16GB/256GB | Phi-4-mini-instruct | Q8_0 (8bit相当) | - | いいえ | - |
| Mac mini (M6) 16GB/256GB | Phi-4-mini-instruct | F16 (無圧縮) | - | いいえ | - |
| Mac mini (M6) 16GB/256GB | Qwen3-8B | Q4_K_M (4bit相当) | - | いいえ | - |
| Mac mini (M6) 16GB/256GB | Qwen3-8B | Q8_0 (8bit相当) | - | いいえ | - |
| Mac mini (M6) 16GB/256GB | Qwen3-8B | F16 (無圧縮) | - | いいえ | - |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-1.7B | Q4_K_M (4bit相当) | 25,094 | いいえ | 64.7–88.2（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-1.7B | Q8_0 (8bit相当) | 17,553 | いいえ | 36.5–49.8（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-1.7B | F16 (無圧縮) | 2,267 | いいえ | 19.4–26.5（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-4B | Q4_K_M (4bit相当) | 9,223 | いいえ | 27.5–37.5（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-4B | Q8_0 (8bit相当) | - | いいえ | - |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-4B | F16 (無圧縮) | - | いいえ | - |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen2.5-3B-Instruct | Q4_K_M (4bit相当) | 32,768 | はい | 36.7–50.0（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen2.5-3B-Instruct | Q8_0 (8bit相当) | 13,393 | いいえ | 20.7–28.2（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen2.5-3B-Instruct | F16 (無圧縮) | - | いいえ | - |
| MacBook Air 13インチ (M4) 16GB/256GB | Llama-3.2-3B-Instruct | Q4_K_M (4bit相当) | 17,613 | いいえ | 36.7–50.0（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Llama-3.2-3B-Instruct | Q8_0 (8bit相当) | 4,305 | いいえ | 20.7–28.2（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Llama-3.2-3B-Instruct | F16 (無圧縮) | - | いいえ | - |
| MacBook Air 13インチ (M4) 16GB/256GB | Phi-4-mini-instruct | Q4_K_M (4bit相当) | 11,383 | いいえ | 28.9–39.5（推定） |
| MacBook Air 13インチ (M4) 16GB/256GB | Phi-4-mini-instruct | Q8_0 (8bit相当) | - | いいえ | - |
| MacBook Air 13インチ (M4) 16GB/256GB | Phi-4-mini-instruct | F16 (無圧縮) | - | いいえ | - |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-8B | Q4_K_M (4bit相当) | - | いいえ | - |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-8B | Q8_0 (8bit相当) | - | いいえ | - |
| MacBook Air 13インチ (M4) 16GB/256GB | Qwen3-8B | F16 (無圧縮) | - | いいえ | - |

## 前提値（assumed）

| 項目 | 値 | 検証状態 |
|---|---:|---|
| kvBytesPerElement | 2 | assumed（実測ではない） |
| osOverheadGB | 8 | assumed（実測ではない） |
| computeOverheadRatio | 0.1 | assumed（実測ではない） |
| usableMemoryRatio | 0.75 | assumed（実測ではない） |
| bandwidthEfficiencyMin | 0.55 | assumed（実測ではない） |
| bandwidthEfficiencyMax | 0.75 | assumed（実測ではない） |
| depreciationMonths | 36 | assumed（実測ではない） |
| electricityYenPerKWh | 31 | assumed（実測ではない） |
| loadWatts | 120 | assumed（実測ではない） |
| hoursPerDay | 8 | assumed（実測ではない） |
| daysPerMonth | 21 | assumed（実測ではない） |

- **結論を支配する前提:** usableMemoryRatio=0.75 により16GB中の実効上限を12GBとし、さらに osOverheadGB=8 を差し引くため、重みとKVキャッシュに使えるのは4GB弱からである。OS実使用量が過大・過小なら最大文脈と収容判定は大きく変わる。

## ハードウェア台帳

| id | 名称 | チップ | メモリGB | 帯域GB/s | 価格円 | specVerify | priceVerify | 出典 |
|---|---|---|---:|---:|---:|---|---|---|
| mac-mini-m4-16 | Mac mini (M4) 16GB/256GB | M4 | 16 | 120 | 94,800 | primary | primary | https://support.apple.com/ja-jp/121555 / https://www.apple.com/jp/newsroom/2024/10/apples-new-mac-mini-is-more-mighty-more-mini-and-built-for-apple-intelligence/ |
| mac-mini-m6-16 | Mac mini (M6) 16GB/256GB | M6 | 16 | 170 | 149,800 | primary | media | tools/mac-local-llm-catalog.json / tools/mac-local-llm-catalog.json |
| macbook-air-m4-16 | MacBook Air 13インチ (M4) 16GB/256GB | M4 | 16 | 120 | 164,800 | primary | primary | https://support.apple.com/ja-jp/122209 / https://www.apple.com/jp/newsroom/2025/03/apple-introduces-the-new-macbook-air-with-the-m4-chip-and-a-sky-blue-color/ |

## モデル台帳

| id | 名称 | params B | 層 | KVヘッド | head_dim | ネイティブ文脈 | shapeVerify | 出典 |
|---|---|---:|---:|---:|---:|---:|---|---|
| qwen3-1.7b | Qwen3-1.7B | 1.7 | 28 | 8 | 128 | 40,960 | primary | https://huggingface.co/Qwen/Qwen3-1.7B/raw/main/config.json |
| qwen3-4b | Qwen3-4B | 4 | 36 | 8 | 128 | 40,960 | primary | https://huggingface.co/Qwen/Qwen3-4B/raw/main/config.json |
| qwen2.5-3b-instruct | Qwen2.5-3B-Instruct | 3 | 36 | 2 | 128 | 32,768 | primary | https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/raw/main/config.json |
| llama-3.2-3b-instruct | Llama-3.2-3B-Instruct | 3 | 28 | 8 | 128 | 131,072 | primary | https://huggingface.co/unsloth/Llama-3.2-3B-Instruct/raw/main/config.json |
| phi-4-mini-instruct | Phi-4-mini-instruct | 3.8 | 32 | 8 | 128 | 131,072 | primary | https://huggingface.co/microsoft/Phi-4-mini-instruct/raw/main/config.json |
| qwen3-8b | Qwen3-8B | 8 | 36 | 8 | 128 | 40,960 | primary | https://huggingface.co/Qwen/Qwen3-8B/raw/main/config.json |

## 経済性

| 機種 | CAPEX円 | 電気代/月円 | 月次保有円 | 3年TCO円 | 損益分岐M token/月 |
|---|---:|---:|---:|---:|---:|
| Mac mini (M4) 16GB/256GB | 94,800 | 625 | 3,258 | 117,299 | - |
| Mac mini (M6) 16GB/256GB | 149,800 | 625 | 4,786 | 172,299 | - |
| MacBook Air 13インチ (M4) 16GB/256GB | 164,800 | 625 | 5,203 | 187,299 | - |

- **クラウド単価未取得のため損益分岐は算出不能**。推測では補完しない。手元の16GB機を再利用する場合、追加CAPEXは0円だが、表は各機の取得価格を使う。

## 未検証（実測が必要なもの）

- 実機・実ランタイム・実プロンプトでのtok/sと出力品質
- 現在の新品・中古実売価格
- `osOverheadGB: 8` と `usableMemoryRatio: 0.75`（実効12GBのうちOSに8GBを割り当てる支配的な仮定）
- クラウド出力単価と実際の月間token量
- Gemma 3 4Bはconfig.jsonが未認証取得で401となったため台帳から除外。M1 AirはApple一次情報で帯域を確認できなかったため除外。

## 出典

### 一次

- Apple「Mac mini (2024) 技術仕様」: https://support.apple.com/ja-jp/121555
- Apple「M4搭載Mac mini発表」: https://www.apple.com/jp/newsroom/2024/10/apples-new-mac-mini-is-more-mighty-more-mini-and-built-for-apple-intelligence/
- Apple「MacBook Air (13-inch, M4, 2025) 技術仕様」: https://support.apple.com/ja-jp/122209
- Apple「M4搭載MacBook Air発表」: https://www.apple.com/jp/newsroom/2025/03/apple-introduces-the-new-macbook-air-with-the-m4-chip-and-a-sky-blue-color/
- Qwen3-1.7B: https://huggingface.co/Qwen/Qwen3-1.7B/raw/main/config.json
- Qwen3-4B: https://huggingface.co/Qwen/Qwen3-4B/raw/main/config.json
- Qwen2.5-3B-Instruct: https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/raw/main/config.json
- Llama-3.2-3B-Instruct: https://huggingface.co/unsloth/Llama-3.2-3B-Instruct/raw/main/config.json
- Phi-4-mini-instruct: https://huggingface.co/microsoft/Phi-4-mini-instruct/raw/main/config.json
- Qwen3-8B: https://huggingface.co/Qwen/Qwen3-8B/raw/main/config.json

### 二次・既存台帳

- M6 Mac miniの価格・帯域: `tools/mac-local-llm-catalog.json`（P-0114で検証済みの値を踏襲）

