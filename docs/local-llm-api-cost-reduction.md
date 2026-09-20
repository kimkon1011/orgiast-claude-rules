# ローカルLLM導入による外部API費用削減の可否（P-0125）

> 判定日: 2026-09-20 / 判定: **見送り（導入しない）**
> 提案原文: 「deepseek4.1 flash や Astra を利用したローカル環境を構築し、外部API利用を段階的に削減する」
> 先行判定 [[feedback_local_llm_hardware_roi]]（2026-08-23・見送り）を**最新の実測で再検証し、追認**した。

## 結論

**見送り。2つの独立した理由があり、どちらか一方だけでも導入は成立しない。**

1. **削減余地が月 $0.88（約136円）しかない。** 従量課金AIの支出は直近30日で **$3.03（約470円）**。うちオープンウェイトで置き換えられるのは gpt-oss-120b 系と qwen 系の **$0.88/月（全体の29%）** だけ。最安クラスの GPU 機（19万円）でも回収は起こらない。
2. **提案が名指しした2モデルは、どちらもこの用途でローカルに置けない。** Astra はウェイト非公開のクラウド専用。DeepSeek-V4-Flash はウェイト公開だが 304B で、Q4 量子化でも 150GB 超を要する。

削減の効き目は**ハード購入ではなく委譲率の改善**にある（先行判定と同じ結論）。

## 1. 現在の従量課金支出（実測トークン × 公開単価）

台帳 `~/.claude/executor-usage.jsonl` の直近30日（2026-08-20〜09-19・6,837コール）の実測トークン量に、各社の公開料金を掛けたもの。

| provider / model | in (tok) | out (tok) | 単価 $/1M (in/out) | 30日支出 |
|---|---:|---:|---|---:|
| GLM-5.3 (Z.ai) | 726,169 | 49,785 | 1.40 / 4.40 | $1.24 |
| DeepSeek chat + v4-flash | 3,490,603 | 222,121 | 0.15 / 0.60（off-peak） | $0.65 |
| Groq gpt-oss-120b | 1,101,893 | 573,439 | 0.15 / 0.60 | $0.51 |
| OpenRouter gpt-oss-120b（+ :online） | 3,908,115 | 1,482,634 | 0.03 / 0.17 | $0.37 |
| Kimi k3 | 24,361 | 12,473 | 3.00 / 15.00 | $0.26 |
| OpenRouter qwen3-coder-flash | 4,884 | 2,468 | 0.20 / 0.97 | $0.005 |
| xAI grok-3 | 73,750 | 1,459 | **未取得** | **未取得** |
| **合計（grok-3 除く）** | | | | **$3.03 / 月（約470円・1USD=155円）** |

単価の出典（一次情報）:
- OpenRouter gpt-oss-120b: https://openrouter.ai/openai/gpt-oss-120b
- OpenRouter qwen3-coder-flash: https://openrouter.ai/qwen/qwen3-coder-flash
- Groq gpt-oss-120b: https://console.groq.com/docs/model/openai/gpt-oss-120b
- DeepSeek: https://api-docs.deepseek.com/quick_start/pricing （peak 時は $0.30/$1.20 で最大2倍）
- Kimi k3: https://platform.kimi.ai/docs/pricing/chat

### 検証状態の注記（推測で埋めていない箇所）

- **grok-3 の単価は未取得。** xAI 公式 https://docs.x.ai/developers/pricing の現行表は grok-4 系のみで grok-3 の記載がない。第三者集計値（$3/$15）は出典が確認できないため不採用とした。ただし grok-3 のトークン量は in 73,750 / out 1,459 と極小で、仮に $3/$15 を当てても月 $0.24 増にとどまり、結論は変わらない。
- **GLM-5.3 の単価は準一次。** z.ai/pricing が動的描画で機械取得できなかったため、値の一致する第三者集計（aipricing.guru / requesty.ai）を採用した。
- **各社の残高API実測は未取得。** keyserve からのキー取り出しが classifier に拒否された（カテゴリ: Credential Exploration）ため、請求実額との突合はしていない。本判定は「実測トークン量 × 公開単価」に基づく推定である。ローカル LLM 側に $3 を大きく超える支出がある可能性は台帳の網羅性から見て低いが、**実額として確認したわけではない**。
- **Claude Code 本体（Opus/Sonnet 等）は定額シート課金のため金額対象外。** ローカルLLMを入れても1円も減らない。codex-cli（定額プラン）と Gemini（無料枠）も同じ理由で対象外。

## 2. 提案が名指ししたモデルの実在性とローカル可否

| 提案中の名称 | 実体 | ローカル実行 | 根拠 |
|---|---|---|---|
| Astra | OpenAI **GPT-6 Astra**（クラウド専用・ChatGPT / API / Azure / Bedrock 経由） | **不可**（ウェイト非公開） | https://openai.com/index/gpt-6-astra/ , https://developers.openai.com/api/docs/models/gpt-6-astra |
| deepseek4.1 flash | **DeepSeek-V4-Flash**（MIT license・オープンウェイト公開） | **実質不可**：304B パラメータ、Q4 量子化でも 150GB 超の VRAM/統合メモリが必要 | https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731 |

- 「Astra」という名のローカル実行可能なモデル／ランタイムが別に存在するかは**未確認**（今回の調査では発見できなかった）。
- V4.1 Flash も大規模（552B クラスとの報道あり・**一次情報未確認**）で、状況は変わらない。

つまり提案の前提「この2つをローカルに置く」は**不成立**である。

## 3. 仮にやるとしたら何になるか（参考）

置き換え先は提案の2モデルではなく、16〜32GB クラスに載るオープンウェイトになる。

| モデル | 規模 | 必要メモリ目安 | ライセンス |
|---|---|---|---|
| gpt-oss-20b | 21B（active 3.6B） | Q4_K_M で約 14GB | Apache-2.0 / https://huggingface.co/openai/gpt-oss-20b |
| Qwen3-30B-A3B（MoE） | 30B（active 3B） | Q4 で 24GB 級 | Apache-2.0 / https://huggingface.co/Qwen |
| Llama 8B〜13B 級 | 8–13B | 16GB 内 | Meta Llama License |

ただしこれらを入れても、**置き換え対象の支出は月 $0.88** である。現用の Groq（0.6秒級）より遅く、品質も下がる。

## 4. 判定と、代わりにやること

**導入しない。** 先行判定 [[feedback_local_llm_hardware_roi]] の3条件は 2026-09-20 時点でも3つとも偽のまま:

1. 機密データを絶対に外に出せない → 偽（既に Claude / Gemini / Groq に業務データを流している）
2. 月 $300 以上の従量課金がある → 偽（**$3.03**。1ヶ月前の $0.23 から13倍に増えたが、依然として桁が2つ足りない）
3. オフライン必須 → 偽

代わりに効くこと（コストゼロで効果が桁違いに大きい順）:

1. **委譲率の改善** — 監督モデルが自分で実装せず安いレーンへ流す割合を上げる。ハード購入より効果が大きく、追加費用ゼロ。
2. **現状維持** — Groq / DeepSeek / OpenRouter / Kimi で月数百円。
3. 手元で試したいだけなら既存の `tools/ollama-ask.mjs`（CPU固定・無料）で体感すれば足りる。

## 5. 再判定の条件（次に同じ提案が来たら）

以下の**どれか1つでも真になるまで再調査しない**。この文書を出して終わりにする。

- 従量課金の月額が **$300 を超えた**（`~/.claude/executor-usage.jsonl` の30日集計で判定）
- 外に出せない機密データを扱う業務が実際に発生した
- オフライン実行が必須の要件が出た

## 関連

- `docs/local-llm-vram-bench.md`（P-0112・VRAM と画質低下閾値の推定モデル）
- `docs/mac-local-llm-plan.md`（P-0114・Mac 32GB 以上の機種別判定）
- `docs/mac-16gb-plan.md`（P-0120・16GB Mac で動く小型モデル台帳）
- `docs/astra-sol-cost-plan.md`（P-0122・Astra / Sol のクラウド単価比較）
