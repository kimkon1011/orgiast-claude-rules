# ローカルLLMのメモリ使用とGPU負荷・画質低下閾値（P-0112）

> このファイルは生成物。手で編集しない。再生成: `node tools/local-llm-vram-bench.mjs --write`
> 台帳: `tools/local-llm-vram-catalog.json`（更新: 2026-09-19）
> 出典区分: `primary`=一次情報 / `media`=二次情報 / `assumed`=仮定 / `unknown`=未取得
> **全数値は推定モデルであり、このセッションでGPU実測はしていない。**

## 結論

- LLMの推論VRAMは「重み + KVキャッシュ + ランタイムoverhead」で決まり、負荷（消費電力・使用率）はVRAM量を変えない。
- VRAM不足時のCPU offload、attention slicing、sequential offload、VAE tilingは画質に影響せず、遅くなるだけである。
- 画質に影響するのは精度降格（fp16→fp8→NF4）、解像度切下げ、ステップ削減、バッチ分割によるシード再生成である。
- **GPU負荷（使用率・温度）は画質を落とさない。画質が落ちるのは精度降格・解像度切下げ・ステップ削減であり、その境界はVRAM量で決まる。**
- 「画質低下の閾値」は `必要VRAM(解像度・精度・バッチ) > 実効VRAM(GPU VRAM × 使用率係数)` となり、画質劣化を伴う退避が初めて必要になる境界として推定する。
- GPUを占有する実測はこのセッションでは行わず、以下は推定モデル・閾値検出器・再現可能な実測手順である。

## 前提値（assumed）

| 項目 | 値 | 検証状態 | 注記 |
|---|---:|---|---|
| vramBytesPerElement | 2 | assumed（実測ではない） | KVキャッシュの要素あたりバイト数。実測ではない |
| runtimeOverheadRatio | 0.1 | assumed（実測ではない） | LLMランタイムの重み比overhead。実測ではない |
| usableVramRatio | 0.9 | assumed（実測ではない） | 物理VRAMのうち推論に使える割合。実測ではない |
| osVramReserveGB | 0.8 | assumed（実測ではない） | OS等の予約領域。実測ではない |
| diffusionOverheadRatio | 0.15 | assumed（実測ではない） | 画像生成ランタイムの追加領域比率。実測ではない |
| vaeTileThresholdGB | null | assumed（実測ではない） | 自動VAE tiling閾値はバックエンド依存のため未設定 |
| offloadSpeedPenaltyMin | 0.05 | assumed（実測ではない） | offload時の速度倍率の下限。実測ではない |
| offloadSpeedPenaltyMax | 0.2 | assumed（実測ではない） | offload時の速度倍率の上限。実測ではない |
| fp8VramRatio | 0.6 | assumed（実測ではない） | fp16比の推定VRAM係数。実測ではない |
| nf4VramRatio | 0.45 | assumed（実測ではない） | fp16比の推定VRAM係数。実測ではない |

## GPU台帳

| id | 名称 | VRAM GB | specVerify | 注記 |
|---|---|---:|---|---|
| rtx-3060-12 | GeForce RTX 3060 12GB | 12 | assumed | 公知スペック・出典URL未取得（要確認） |
| rtx-4060ti-16 | GeForce RTX 4060 Ti 16GB | 16 | assumed | 公知スペック・出典URL未取得（要確認） |
| rtx-4090-24 | GeForce RTX 4090 24GB | 24 | assumed | 公知スペック・出典URL未取得（要確認） |
| none-cpu-only | GPUなし（CPUのみ） | 0 | assumed | GPUなし=CPU実行の基準線 |

## LLM 実行可能性マトリクス

必要GB は各モデルの**ネイティブ文脈長**（例: Llama-3.1-8B は 131,072 tokens）で計算している。KVキャッシュが支配的なため、実運用の文脈長（例 8,192 tokens）に落とすと必要GBは大きく下がる。右端の列に 8,192 tokens での必要GB を併記する。

### Llama-3.1-8B-Instruct

| GPU | 量子化 | 必要GB | 実効GB | 直接収容 | 退避後 | 推定tok/s | 必要GB(8k文脈) |
|---|---|---:|---:|---|---|---:|---:|
| GeForce RTX 3060 12GB | Q4_K_M | 23.3 | 10.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 7.2 |
| GeForce RTX 3060 12GB | Q8_0 | 27.3 | 10.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 11.2 |
| GeForce RTX 3060 12GB | F16 | 35.6 | 10.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 19.5 |
| GeForce RTX 4060 Ti 16GB | Q4_K_M | 23.3 | 13.6 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 7.2 |
| GeForce RTX 4060 Ti 16GB | Q8_0 | 27.3 | 13.6 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 11.2 |
| GeForce RTX 4060 Ti 16GB | F16 | 35.6 | 13.6 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 19.5 |
| GeForce RTX 4090 24GB | Q4_K_M | 23.3 | 20.8 | 収容不可 | cpu-offload | - | 7.2 |
| GeForce RTX 4090 24GB | Q8_0 | 27.3 | 20.8 | 収容不可 | cpu-offload | - | 11.2 |
| GeForce RTX 4090 24GB | F16 | 35.6 | 20.8 | 収容不可 | cpu-offload | - | 19.5 |
| GPUなし（CPUのみ） | Q4_K_M | 23.3 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 7.2 |
| GPUなし（CPUのみ） | Q8_0 | 27.3 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 11.2 |
| GPUなし（CPUのみ） | F16 | 35.6 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 19.5 |

### Mistral-7B-Instruct-v0.3

| GPU | 量子化 | 必要GB | 実効GB | 直接収容 | 退避後 | 推定tok/s | 必要GB(8k文脈) |
|---|---|---:|---:|---|---|---:|---:|
| GeForce RTX 3060 12GB | Q4_K_M | 9.7 | 10.0 | 収容可 | - | - | 6.5 |
| GeForce RTX 3060 12GB | Q8_0 | 13.3 | 10.0 | 収容不可 | cpu-offload | - | 10.1 |
| GeForce RTX 3060 12GB | F16 | 20.5 | 10.0 | 収容不可 | cpu-offload | - | 17.3 |
| GeForce RTX 4060 Ti 16GB | Q4_K_M | 9.7 | 13.6 | 収容可 | - | - | 6.5 |
| GeForce RTX 4060 Ti 16GB | Q8_0 | 13.3 | 13.6 | 収容可 | - | - | 10.1 |
| GeForce RTX 4060 Ti 16GB | F16 | 20.5 | 13.6 | 収容不可 | cpu-offload | - | 17.3 |
| GeForce RTX 4090 24GB | Q4_K_M | 9.7 | 20.8 | 収容可 | - | - | 6.5 |
| GeForce RTX 4090 24GB | Q8_0 | 13.3 | 20.8 | 収容可 | - | - | 10.1 |
| GeForce RTX 4090 24GB | F16 | 20.5 | 20.8 | 収容可 | - | - | 17.3 |
| GPUなし（CPUのみ） | Q4_K_M | 9.7 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 6.5 |
| GPUなし（CPUのみ） | Q8_0 | 13.3 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 10.1 |
| GPUなし（CPUのみ） | F16 | 20.5 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 17.3 |

### Llama-3.1-70B-Instruct

| GPU | 量子化 | 必要GB | 実効GB | 直接収容 | 退避後 | 推定tok/s | 必要GB(8k文脈) |
|---|---|---:|---:|---|---|---:|---:|
| GeForce RTX 3060 12GB | Q4_K_M | 89.9 | 10.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 49.7 |
| GeForce RTX 3060 12GB | Q8_0 | 125.6 | 10.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 85.3 |
| GeForce RTX 3060 12GB | F16 | 197.7 | 10.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 157.5 |
| GeForce RTX 4060 Ti 16GB | Q4_K_M | 89.9 | 13.6 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 49.7 |
| GeForce RTX 4060 Ti 16GB | Q8_0 | 125.6 | 13.6 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 85.3 |
| GeForce RTX 4060 Ti 16GB | F16 | 197.7 | 13.6 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 157.5 |
| GeForce RTX 4090 24GB | Q4_K_M | 89.9 | 20.8 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 49.7 |
| GeForce RTX 4090 24GB | Q8_0 | 125.6 | 20.8 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 85.3 |
| GeForce RTX 4090 24GB | F16 | 197.7 | 20.8 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 157.5 |
| GPUなし（CPUのみ） | Q4_K_M | 89.9 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 49.7 |
| GPUなし（CPUのみ） | Q8_0 | 125.6 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 85.3 |
| GPUなし（CPUのみ） | F16 | 197.7 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 157.5 |

### Mixtral-8x7B-Instruct

| GPU | 量子化 | 必要GB | 実効GB | 直接収容 | 退避後 | 推定tok/s | 必要GB(8k文脈) |
|---|---|---:|---:|---|---|---:|---:|
| GeForce RTX 3060 12GB | Q4_K_M | 35.9 | 10.0 | 収容不可 | cpu-offload | - | 32.7 |
| GeForce RTX 3060 12GB | Q8_0 | 59.7 | 10.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 56.5 |
| GeForce RTX 3060 12GB | F16 | 107.8 | 10.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 104.6 |
| GeForce RTX 4060 Ti 16GB | Q4_K_M | 35.9 | 13.6 | 収容不可 | cpu-offload | - | 32.7 |
| GeForce RTX 4060 Ti 16GB | Q8_0 | 59.7 | 13.6 | 収容不可 | cpu-offload | - | 56.5 |
| GeForce RTX 4060 Ti 16GB | F16 | 107.8 | 13.6 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 104.6 |
| GeForce RTX 4090 24GB | Q4_K_M | 35.9 | 20.8 | 収容不可 | cpu-offload | - | 32.7 |
| GeForce RTX 4090 24GB | Q8_0 | 59.7 | 20.8 | 収容不可 | cpu-offload | - | 56.5 |
| GeForce RTX 4090 24GB | F16 | 107.8 | 20.8 | 収容不可 | cpu-offload | - | 104.6 |
| GPUなし（CPUのみ） | Q4_K_M | 35.9 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 32.7 |
| GPUなし（CPUのみ） | Q8_0 | 59.7 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 56.5 |
| GPUなし（CPUのみ） | F16 | 107.8 | 0.0 | 収容不可 | cpu-offload → precision-downgrade-fp8 → precision-downgrade-nf4 → context-reduction | - | 104.6 |

収容不可の行は、実測していない速度（tok/s）を表示しない。CPU offload適用後も元の必要VRAM値は変えず、GPU常駐量だけが減る意味論で判定する。

## 退避動作と画質への影響

| 動作 | 画質影響 | 速度影響 | 発動条件 |
|---|---|---|---|
| CPU offload / sequential offload | none（画質不変） | 大（転送待ち） | GPU VRAM不足時に重みをCPUへ退避 |
| Attention slicing | none（画質不変） | 中 | attention作業領域が不足 |
| VAE tiling | none（画質不変） | 中 | VAE処理のピークVRAM不足 |
| fp16→fp8精度降格 | **low（画質低下）** | 環境依存 | 無劣化退避後もVRAM不足 |
| fp8→NF4精度降格 | **high（画質低下）** | 環境依存 | fp8でもVRAM不足 |
| 解像度切り下げ | **high（画質低下）** | 高速化 | NF4でもVRAM不足 |
| ステップ数削減 | **high（画質低下）** | 高速化 | 時間・計算量制約 |
| 文脈長の切下げ | **medium（画質低下）** | 高速化 | NF4でも収容不可 |

## 画像生成のVRAMフットプリント

| モデル | 解像度 | 精度 | 推定VRAM GB |
|---|---:|---|---:|
| Stable Diffusion 1.5 | 512×512 | fp16 | 4.4（推定） |
| Stable Diffusion 1.5 | 512×512 | fp8 | 2.9（推定） |
| Stable Diffusion 1.5 | 512×512 | nf4 | 2.4（推定） |
| Stable Diffusion 1.5 | 1024×1024 | fp16 | 5.5（推定） |
| Stable Diffusion 1.5 | 1024×1024 | fp8 | 3.6（推定） |
| Stable Diffusion 1.5 | 1024×1024 | nf4 | 2.9（推定） |
| Stable Diffusion 1.5 | 1536×1536 | fp16 | 7.3（推定） |
| Stable Diffusion 1.5 | 1536×1536 | fp8 | 4.7（推定） |
| Stable Diffusion 1.5 | 1536×1536 | nf4 | 3.7（推定） |
| Stable Diffusion 1.5 | 2048×2048 | fp16 | 9.8（推定） |
| Stable Diffusion 1.5 | 2048×2048 | fp8 | 6.2（推定） |
| Stable Diffusion 1.5 | 2048×2048 | nf4 | 4.9（推定） |
| Stable Diffusion XL | 512×512 | fp16 | 9.1（推定） |
| Stable Diffusion XL | 512×512 | fp8 | 5.8（推定） |
| Stable Diffusion XL | 512×512 | nf4 | 4.5（推定） |
| Stable Diffusion XL | 1024×1024 | fp16 | 11.7（推定） |
| Stable Diffusion XL | 1024×1024 | fp8 | 7.3（推定） |
| Stable Diffusion XL | 1024×1024 | nf4 | 5.7（推定） |
| Stable Diffusion XL | 1536×1536 | fp16 | 15.9（推定） |
| Stable Diffusion XL | 1536×1536 | fp8 | 9.8（推定） |
| Stable Diffusion XL | 1536×1536 | nf4 | 7.6（推定） |
| Stable Diffusion XL | 2048×2048 | fp16 | 21.8（推定） |
| Stable Diffusion XL | 2048×2048 | fp8 | 13.4（推定） |
| Stable Diffusion XL | 2048×2048 | nf4 | 10.2（推定） |
| FLUX.1-dev | 512×512 | fp16 | 18.3（推定） |
| FLUX.1-dev | 512×512 | fp8 | 11.3（推定） |
| FLUX.1-dev | 512×512 | nf4 | 8.7（推定） |
| FLUX.1-dev | 1024×1024 | fp16 | 22.3（推定） |
| FLUX.1-dev | 1024×1024 | fp8 | 13.7（推定） |
| FLUX.1-dev | 1024×1024 | nf4 | 10.5（推定） |
| FLUX.1-dev | 1536×1536 | fp16 | 29.1（推定） |
| FLUX.1-dev | 1536×1536 | fp8 | 17.8（推定） |
| FLUX.1-dev | 1536×1536 | nf4 | 13.5（推定） |
| FLUX.1-dev | 2048×2048 | fp16 | 38.6（推定） |
| FLUX.1-dev | 2048×2048 | fp8 | 23.5（推定） |
| FLUX.1-dev | 2048×2048 | nf4 | 17.8（推定） |

## 画質低下の閾値

| GPU | 画像モデル | 閾値px（推定） | 直前の安全px | 最初の劣化退避 | 備考 |
|---|---|---:|---:|---|---|
| GeForce RTX 3060 12GB | Stable Diffusion 1.5 | - | 2048 | - | 推定（2048pxまで画質劣化を伴う退避なし） |
| GeForce RTX 3060 12GB | Stable Diffusion XL | 1792 | 1664 | precision-downgrade-nf4 | 推定（estimated） |
| GeForce RTX 3060 12GB | FLUX.1-dev | - | - | precision-downgrade-nf4 | 推定（走査開始の512pxから画質劣化を伴う退避が必要） |
| GeForce RTX 4060 Ti 16GB | Stable Diffusion 1.5 | - | 2048 | - | 推定（2048pxまで画質劣化を伴う退避なし） |
| GeForce RTX 4060 Ti 16GB | Stable Diffusion XL | - | 2048 | - | 推定（2048pxまで画質劣化を伴う退避なし） |
| GeForce RTX 4060 Ti 16GB | FLUX.1-dev | 1280 | 1152 | precision-downgrade-nf4 | 推定（estimated） |
| GeForce RTX 4090 24GB | Stable Diffusion 1.5 | - | 2048 | - | 推定（2048pxまで画質劣化を伴う退避なし） |
| GeForce RTX 4090 24GB | Stable Diffusion XL | - | 2048 | - | 推定（2048pxまで画質劣化を伴う退避なし） |
| GeForce RTX 4090 24GB | FLUX.1-dev | 2048 | 1920 | precision-downgrade-nf4 | 推定（estimated） |
| GPUなし（CPUのみ） | Stable Diffusion 1.5 | - | - | resolution-downscale | 推定（走査開始の512pxから画質劣化を伴う退避が必要） |
| GPUなし（CPUのみ） | Stable Diffusion XL | - | - | resolution-downscale | 推定（走査開始の512pxから画質劣化を伴う退避が必要） |
| GPUなし（CPUのみ） | FLUX.1-dev | - | - | resolution-downscale | 推定（走査開始の512pxから画質劣化を伴う退避が必要） |

## 実測手順（次回以降に実測するための手順）

1. `nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv -l 1` でVRAM使用量とGPU使用率を1秒間隔で記録する。
2. llama.cppは同一モデル・量子化・プロンプトで `--n-gpu-layers` を段階的に変え、VRAM、生成速度、CPU offload境界を記録する。
3. diffusersは同一モデル・同一seedで通常実行、`enable_model_cpu_offload()`、`enable_sequential_cpu_offload()`、`enable_attention_slicing()` を個別に比較し、必要ならVAE tilingも比較する。
4. fp16、fp8、NF4、解像度、ステップ数を一要因ずつ変え、ピークVRAMと実行時間を記録する。
5. **画質が落ちたかどうかは主観で判定せず、同一シードの画素差分（PSNR/SSIM）で判定する。** バッチ分割でseed対応が変わった場合は別試行として記録する。
6. 推定閾値の前後（128px刻み）を重点測定し、初めてPSNR/SSIMが変化する設定を実測閾値として台帳へ反映する。

## 未実測（実測が必要なもの）

- GPU別・バックエンド別の実効VRAM比率とランタイムoverhead
- CPU/sequential offload、attention slicing、VAE tilingの実速度低下
- fp8/NF4のVRAM削減率とPSNR/SSIMへの影響
- モデル・解像度・バッチごとのピークVRAMと画質低下閾値
- GPU温度・使用率と速度低下（画質低下ではない）の関係

## 出典

### 一次

- 取得済み一次URLなし。

### 二次

- 取得済み二次URLなし。

### 未取得

- 公知スペックおよび推定係数: 出典未取得（このセッションでは一次・二次URLを取得していない。全数要確認）
- Llama-3.1-8B-Instruct shape: 出典未取得（assumed）
- Mistral-7B-Instruct-v0.3 shape: 出典未取得（assumed）
- Llama-3.1-70B-Instruct shape: 出典未取得（assumed）
- Mixtral-8x7B-Instruct shape: 出典未取得（assumed）
- GeForce RTX 3060 12GB: 出典未取得（assumed）
- GeForce RTX 4060 Ti 16GB: 出典未取得（assumed）
- GeForce RTX 4090 24GB: 出典未取得（assumed）
- GPUなし（CPUのみ）: 出典未取得（assumed）

