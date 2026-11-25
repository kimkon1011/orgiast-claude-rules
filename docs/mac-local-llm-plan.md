# Mac ローカルLLM環境 導入可否評価（P-0114）

> このファイルは生成物。手で編集しない。再生成: `node tools/mac-local-llm-plan.mjs --write`
> 台帳: `tools/mac-local-llm-catalog.json`（更新: 2026-09-19）
> 出典区分: `primary`=一次情報で確認 / `media`=報道ベース（二次） / `assumed`=前提値（要実測）
> **実測していない値（tok/s・電気代・実売価格）は推定であり、断定ではない。**

## 結論

- モデル別判定: Qwen3-8B「対話可」（Mac mini (M6) 以上）、Qwen3-32B「対話可」（Mac mini (M5 Pro) 以上）、Llama-3.3-70B-Instruct「対話可」（Mac Studio (M5 Ultra) のみ・推定上限 21.4 tok/s）、Qwen2.5-72B-Instruct「対話可」（Mac Studio (M5 Max) 以上）。
- つまり 70B 級を動かすには 21.4 tok/s 推定・94.98 万円〜の Mac Studio M5 Ultra しか選択肢がなく、「開発チームに配備してスピード向上」の費用対効果はこの 1 点で決まる。
- 上記の「しか選択肢がなく」は Llama-3.3-70B-Instruct のネイティブ文脈長・Q4_K_M 条件を指す。Qwen2.5-72B-Instruct は文脈長が異なり、Mac Studio (M5 Max) でも収容可能という推定。
- ネイティブ文脈長では、32B級Q4_K_Mは64GB以上、Llama-3.3-70B-Instruct Q4_K_Mはこの台帳上512GB機だけが収容可能という推定で、32GB機は8B級に限られる。
- ローカル LLM は**フロンティアモデルの代替にはならない**。開発スピード向上に効く主用途は対話的なコーディングではなく、**大量バッチ処理・機密データ・オフライン**である。
- tok/s、電気代、価格は未実測であり、購入前に候補機でのベンチマークと見積取得が必要。

## サマリ表

| 機械 | Qwen3-32B Q4_K_M | Llama-3.3-70B Q4_K_M |
|---|---|---|
| Mac mini (M6) | 動かない / 4.9–6.6 tok/s（推定） | 動かない / 2.2–3.0 tok/s（推定） |
| Mac mini (M5 Pro) | 動く / 8.8–12.0 tok/s（推定） | 動かない / 4.0–5.5 tok/s（推定） |
| Mac Studio (M5 Max) | 動く / 17.6–24.0 tok/s（推定） | 動かない / 8.0–11.0 tok/s（推定） |
| Mac Studio (M5 Ultra) | 動く / 34.4–46.9 tok/s（推定） | 動く / 15.7–21.4 tok/s（推定） |

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

## ハードウェア台帳

| id | 名称 | チップ | 最大メモリGB | 帯域GB/s | 価格円 | specVerify | priceVerify | availability |
|---|---|---|---:|---:|---:|---|---|---|
| mac-mini-m6-32 | Mac mini (M6) | M6 | 32 | 170 | 221,800 | primary | media | 2026-09-22 発売 |
| mac-mini-m5-pro-64 | Mac mini (M5 Pro) | M5 Pro | 64 | 307 | 299,800 | primary | media | 2026-09-22 発売 |
| mac-studio-m5-max-128 | Mac Studio (M5 Max) | M5 Max | 128 | 614 | 419,800 | primary | media | 2026-09-22 発売 |
| mac-studio-m5-ultra-512 | Mac Studio (M5 Ultra) | M5 Ultra | 512 | 1200 | 949,800 | primary | media | 2026-09-22 発売（512GB 構成は 2026年10月後半） |

## モデル台帳

| id | 名称 | パラメータ数B | 層 | KVヘッド | head_dim | ネイティブ文脈長 | shapeVerify | 出典 URL |
|---|---|---:|---:|---:|---:|---:|---|---|
| qwen3-8b | Qwen3-8B | 8 | 36 | 8 | 128 | 40960 | primary | https://huggingface.co/Qwen/Qwen3-8B/raw/main/config.json |
| qwen3-32b | Qwen3-32B | 32 | 64 | 8 | 128 | 40960 | primary | https://huggingface.co/Qwen/Qwen3-32B/raw/main/config.json |
| llama-3.3-70b | Llama-3.3-70B-Instruct | 70 | 80 | 8 | 128 | 131072 | primary | https://huggingface.co/unsloth/Llama-3.3-70B-Instruct/raw/main/config.json |
| qwen2.5-72b | Qwen2.5-72B-Instruct | 72 | 80 | 8 | 128 | 32768 | primary | https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/raw/main/config.json |

## 実行可能性マトリクス

### Qwen3-8B

| 機械 | 量子化 | 必要メモリGB | 実効上限GB | 判定 | 余裕GB | 推定tok/s帯 |
|---|---|---:|---:|---|---:|---:|
| Mac mini (M6) | Q4_K_M (4bit相当) | 19.3 | 24.0 | 動く | 4.7 | 19.5–26.6（推定） |
| Mac mini (M6) | Q8_0 (8bit相当) | 23.4 | 24.0 | 動く | 0.6 | 11.0–15.0（推定） |
| Mac mini (M6) | F16 (無圧縮) | 31.6 | 24.0 | 動かない | -7.6 | - |
| Mac mini (M5 Pro) | Q4_K_M (4bit相当) | 19.3 | 48.0 | 動く | 28.7 | 35.2–48.0（推定） |
| Mac mini (M5 Pro) | Q8_0 (8bit相当) | 23.4 | 48.0 | 動く | 24.6 | 19.9–27.1（推定） |
| Mac mini (M5 Pro) | F16 (無圧縮) | 31.6 | 48.0 | 動く | 16.4 | 10.6–14.4（推定） |
| Mac Studio (M5 Max) | Q4_K_M (4bit相当) | 19.3 | 96.0 | 動く | 76.7 | 70.4–95.9（推定） |
| Mac Studio (M5 Max) | Q8_0 (8bit相当) | 23.4 | 96.0 | 動く | 72.6 | 39.7–54.2（推定） |
| Mac Studio (M5 Max) | F16 (無圧縮) | 31.6 | 96.0 | 動く | 64.4 | 21.1–28.8（推定） |
| Mac Studio (M5 Ultra) | Q4_K_M (4bit相当) | 19.3 | 384.0 | 動く | 364.7 | 137.5–187.5（推定） |
| Mac Studio (M5 Ultra) | Q8_0 (8bit相当) | 23.4 | 384.0 | 動く | 360.6 | 77.6–105.9（推定） |
| Mac Studio (M5 Ultra) | F16 (無圧縮) | 31.6 | 384.0 | 動く | 352.4 | 41.3–56.3（推定） |

### Qwen3-32B

| 機械 | 量子化 | 必要メモリGB | 実効上限GB | 判定 | 余裕GB | 推定tok/s帯 |
|---|---|---:|---:|---|---:|---:|
| Mac mini (M6) | Q4_K_M (4bit相当) | 39.9 | 24.0 | 動かない | -15.9 | - |
| Mac mini (M6) | Q8_0 (8bit相当) | 56.1 | 24.0 | 動かない | -32.1 | - |
| Mac mini (M6) | F16 (無圧縮) | 89.1 | 24.0 | 動かない | -65.1 | - |
| Mac mini (M5 Pro) | Q4_K_M (4bit相当) | 39.9 | 48.0 | 動く | 8.1 | 8.8–12.0（推定） |
| Mac mini (M5 Pro) | Q8_0 (8bit相当) | 56.1 | 48.0 | 動かない | -8.1 | - |
| Mac mini (M5 Pro) | F16 (無圧縮) | 89.1 | 48.0 | 動かない | -41.1 | - |
| Mac Studio (M5 Max) | Q4_K_M (4bit相当) | 39.9 | 96.0 | 動く | 56.1 | 17.6–24.0（推定） |
| Mac Studio (M5 Max) | Q8_0 (8bit相当) | 56.1 | 96.0 | 動く | 39.9 | 9.9–13.5（推定） |
| Mac Studio (M5 Max) | F16 (無圧縮) | 89.1 | 96.0 | 動く | 6.9 | 5.3–7.2（推定） |
| Mac Studio (M5 Ultra) | Q4_K_M (4bit相当) | 39.9 | 384.0 | 動く | 344.1 | 34.4–46.9（推定） |
| Mac Studio (M5 Ultra) | Q8_0 (8bit相当) | 56.1 | 384.0 | 動く | 327.9 | 19.4–26.5（推定） |
| Mac Studio (M5 Ultra) | F16 (無圧縮) | 89.1 | 384.0 | 動く | 294.9 | 10.3–14.1（推定） |

### Llama-3.3-70B-Instruct

| 機械 | 量子化 | 必要メモリGB | 実効上限GB | 判定 | 余裕GB | 推定tok/s帯 |
|---|---|---:|---:|---|---:|---:|
| Mac mini (M6) | Q4_K_M (4bit相当) | 97.1 | 24.0 | 動かない | -73.1 | - |
| Mac mini (M6) | Q8_0 (8bit相当) | 132.8 | 24.0 | 動かない | -108.8 | - |
| Mac mini (M6) | F16 (無圧縮) | 204.9 | 24.0 | 動かない | -180.9 | - |
| Mac mini (M5 Pro) | Q4_K_M (4bit相当) | 97.1 | 48.0 | 動かない | -49.1 | - |
| Mac mini (M5 Pro) | Q8_0 (8bit相当) | 132.8 | 48.0 | 動かない | -84.8 | - |
| Mac mini (M5 Pro) | F16 (無圧縮) | 204.9 | 48.0 | 動かない | -156.9 | - |
| Mac Studio (M5 Max) | Q4_K_M (4bit相当) | 97.1 | 96.0 | 動かない | -1.1 | - |
| Mac Studio (M5 Max) | Q8_0 (8bit相当) | 132.8 | 96.0 | 動かない | -36.8 | - |
| Mac Studio (M5 Max) | F16 (無圧縮) | 204.9 | 96.0 | 動かない | -108.9 | - |
| Mac Studio (M5 Ultra) | Q4_K_M (4bit相当) | 97.1 | 384.0 | 動く | 286.9 | 15.7–21.4（推定） |
| Mac Studio (M5 Ultra) | Q8_0 (8bit相当) | 132.8 | 384.0 | 動く | 251.2 | 8.9–12.1（推定） |
| Mac Studio (M5 Ultra) | F16 (無圧縮) | 204.9 | 384.0 | 動く | 179.1 | 4.7–6.4（推定） |

### Qwen2.5-72B-Instruct

| 機械 | 量子化 | 必要メモリGB | 実効上限GB | 判定 | 余裕GB | 推定tok/s帯 |
|---|---|---:|---:|---|---:|---:|
| Mac mini (M6) | Q4_K_M (4bit相当) | 66.3 | 24.0 | 動かない | -42.3 | - |
| Mac mini (M6) | Q8_0 (8bit相当) | 102.9 | 24.0 | 動かない | -78.9 | - |
| Mac mini (M6) | F16 (無圧縮) | 177.1 | 24.0 | 動かない | -153.1 | - |
| Mac mini (M5 Pro) | Q4_K_M (4bit相当) | 66.3 | 48.0 | 動かない | -18.3 | - |
| Mac mini (M5 Pro) | Q8_0 (8bit相当) | 102.9 | 48.0 | 動かない | -54.9 | - |
| Mac mini (M5 Pro) | F16 (無圧縮) | 177.1 | 48.0 | 動かない | -129.1 | - |
| Mac Studio (M5 Max) | Q4_K_M (4bit相当) | 66.3 | 96.0 | 動く | 29.7 | 7.8–10.7（推定） |
| Mac Studio (M5 Max) | Q8_0 (8bit相当) | 102.9 | 96.0 | 動かない | -6.9 | - |
| Mac Studio (M5 Max) | F16 (無圧縮) | 177.1 | 96.0 | 動かない | -81.1 | - |
| Mac Studio (M5 Ultra) | Q4_K_M (4bit相当) | 66.3 | 384.0 | 動く | 317.7 | 15.3–20.8（推定） |
| Mac Studio (M5 Ultra) | Q8_0 (8bit相当) | 102.9 | 384.0 | 動く | 281.1 | 8.6–11.8（推定） |
| Mac Studio (M5 Ultra) | F16 (無圧縮) | 177.1 | 384.0 | 動く | 206.9 | 4.6–6.3（推定） |

## 経済性

| 機械 | CAPEX円 | 電気代/月円 | 電気代/年円 | 月次保有コスト円 | 3年TCO円 | 損益分岐M tok/月 |
|---|---:|---:|---:|---:|---:|---:|
| Mac mini (M6) | 221,800 | 625 | 7,500 | 6,786 | 244,299 | - |
| Mac mini (M5 Pro) | 299,800 | 625 | 7,500 | 8,953 | 322,299 | - |
| Mac Studio (M5 Max) | 419,800 | 625 | 7,500 | 12,286 | 442,299 | - |
| Mac Studio (M5 Ultra) | 949,800 | 625 | 7,500 | 27,008 | 972,299 | - |

- 価格は報道値であり、各行の構成価格とは限らない。特にMac Studioは最安構成価格を使った下限値で、128GB/512GB構成の実価格ではない。
- M5 Ultra 512GB構成の価格は未取得。上表の949,800円とそれに基づく経済性は最安構成の下限値である。
- **単価が未取得のため損益分岐は算出不能**。推測値では補完しない。

## 判定（この構成で「開発スピードが上がるか」）

| モデル | verdict | 動く機械（推定tok/s上限） |
|---|---|---|
| Qwen3-8B | 対話可 | Mac mini (M6) 26.6 / Mac mini (M5 Pro) 48.0 / Mac Studio (M5 Max) 95.9 / Mac Studio (M5 Ultra) 187.5 |
| Qwen3-32B | 対話可 | Mac mini (M5 Pro) 12.0 / Mac Studio (M5 Max) 24.0 / Mac Studio (M5 Ultra) 46.9 |
| Llama-3.3-70B-Instruct | 対話可 | Mac Studio (M5 Ultra) 21.4 |
| Qwen2.5-72B-Instruct | 対話可 | Mac Studio (M5 Max) 10.7 / Mac Studio (M5 Ultra) 20.8 |

「動く機械」は Q4_K_M で収容できる機械だけをカタログ順に並べ、括弧内はその機械での推定上限 tok/s。

20 tok/sを「人が待たされない対話」の判定目安とする。これは実測値でも絶対基準でもなく、業界一般の目安である。モデル判定は、動く構成がなければ「動かない」、動く全構成の推定上限が20 tok/s未満なら「バッチ向け」、それ以外を「対話可」とした。

- 向く: 大量バッチ分類・抽出、機密データのローカル処理、オフライン/ネットワーク制限環境
- 向かない: フロンティアモデル並みの品質が要るエージェント的コーディング、長文脈の高精度推論
- 調達リスク: 世界的なメモリ不足で512GB構成は2026年10月後半まで提供されない（報道ベースで未検証）

## 未検証（実測が必要なもの）

- 実 tok/s
- 実売価格（報道ベース）
- 512GB構成の価格と提供時期
- 電気代の実測
- クラウド単価（損益分岐に必須）

## 出典

### 一次

- Apple 日本公式スペックページ（2026-09-19取得。カタログのハードウェア仕様）
- Qwen3-8B: https://huggingface.co/Qwen/Qwen3-8B/raw/main/config.json
- Qwen3-32B: https://huggingface.co/Qwen/Qwen3-32B/raw/main/config.json
- Llama-3.3-70B-Instruct: https://huggingface.co/unsloth/Llama-3.3-70B-Instruct/raw/main/config.json
- Qwen2.5-72B-Instruct: https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/raw/main/config.json

### 二次

- 2026-08-25発表の報道（価格・発売時期・メモリ供給状況）

