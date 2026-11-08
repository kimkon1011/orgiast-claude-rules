# X-0016 出力ディレクトリ解説

AIニュース提案 X-0016「プレフィックスキャッシュによるKV共有でメモリ・コスト削減」の
処理レポートを置く場所です。2026-11-09 の自動セッションで作成。

## 結論（TL;DR）

**X-0016 のテーマは X-0009（KVキャッシュプレフィックス共有ゲートウェイ）と同一トピックで、
実装は既に main に取り込まれている**（`tools/kv-cache-prefix-gateway.mjs`・`tools/kv-cache-prefix-gateway.test.mjs`・
`tools/prefix-cache-bench.mjs`・`docs/ai-news-x0009-kv-cache-prefix-sharing.md`・`outputs/X-0009/`）。

- X-0009 が扱うのは主に **TTFT とコスト**（キャッシュ割引）。実測シミュレーションで TTFT −82.8〜85.0%・コスト −60〜68.6%。
- X-0016 の元ニュースが特有に含むのは **KV キャッシュのメモリ定量**（32層GQA・ヘッド次元128・BF16 で
  8192トークン = 1GiB、16独立シーケンス = 16GiB）。この **メモリ側の数値は X-0009 の成果物には未収録**だった。
- 本セッションの仕事 = この差分（メモリ定量分析）を検算して文書化し、X-0009 実装を使って
  「類似ブース提案で共通プレフィックス」を試す運用プランに接続した。

## ディレクトリ構造

```
outputs/X-0016/
├── README.md                 # 本解説（X-0009との関係・差分・検証結果）
└── memory-metric-analysis.md # KVキャッシュメモリ定量分析（1GiB/16GiB の検算・共有効果の表）
```

本体の設計・実装は X-0009 の `docs/ai-news-x0009-kv-cache-prefix-sharing.md` と
本差分の `docs/ai-news-x0016-kv-memory-sharing.md`（リポジトリ docs/ 配下）を参照。

## 検証結果（2026-11-09 実測）

| 項目 | 結果 |
|---|---|
| `node --test tools/kv-cache-prefix-gateway.test.mjs` | 18 tests pass / 0 fail（main 上） |
| 1GiB 検算（KVヘッド8本・BF16） | 32×8×128×4B×8192 = 1,073,741,824 B = 1 GiB 一致 |
| PR #1746（旧 X-0009 実装枝） | 内容が main と同一のため stale → 本セッションで obsolete クローズ |

## 残り

- [ ] OpenRouter/Anthropic 実 API でのキャッシュヒット実測（`usage.cached_tokens` / `cache_creation` の読み取り）は
      X-0009 依存の残TODO。検証は次回の自動セッションで。
- [ ] 本番アプリ（booth-production-app 提案生成パイプライン）へのゲートウェイ統合判断はビジネス側。
      「共通プレフィックス固定＋類似案件を連続生成」の運用は X-0009 実装のデモモードで即試行可能。