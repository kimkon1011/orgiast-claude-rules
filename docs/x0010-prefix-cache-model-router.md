# X-0010: プレフィックスキャッシュとモデルルーター

## 実装範囲

2026-11-09にオフライン検証。新規ファイルのみ追加。API呼び出し・外部送信・デプロイは実装していない。Anthropic指定とClaudeモデルを拒否し、OpenRouterのみを使用する。complexの既定は仕様表のopenai/gpt-4o。既存provider-routing.mjsのgatewayModel/routeCandidateを再利用する。

cost-routing-gate.mjsとrouting-table.mjsの実行フローには未接続。前者の設計・分類・要約の分類体系と、後者の品質評価に基づく選択方式を踏まえた独立モジュールであり、本番ルーティングは変更していない。

## 再現手順

```sh
node --test tools/model-router.test.mjs
node tools/prefix-cache-bench.mjs --dry-run
node tools/model-router.mjs classify "問い合わせを分類"
node tools/model-router.mjs estimate --route simple --tokens 1000
node tools/model-router.mjs load-test --count 100
node tools/model-router.mjs benchmark --out /tmp/x0010-router.md
```

--dry-runなしのキャッシュベンチマークは非ゼロ終了。--provider anthropicも拒否。キャッシュベンチマークは--outでMarkdownを保存できる。

## キャッシュ模擬結果

# Prefix caching benchmark (dry-run / simulation)

Provider: openrouter; model label: openai/gpt-4o. No API calls. Actual billed cost: $0.
All values are fixtures independent of model pricing. Cold TTFT 800ms and 10,000 input tokens are illustrative assumptions. Costs below are supplied post-discount mock values, not measured billing.

| Workload | Cold TTFT ms | Warm TTFT ms | Saving ms | Cached/input tokens | Cache hit | Mock discounted USD |
|---|---:|---:|---:|---:|---:|---:|
| repeated_system | 800 | 150 | 650 | 8500/10000 | 85% | $0.0012 |
| similar_context | 800 | 300 | 500 | 4500/10000 | 45% | $0.0035 |
| unique | 800 | 800 | 0 | 0/10000 | 0% | $0.0080 |

Workloads: repeated_system shares the complete system prefix; similar_context shares part of a long prefix; unique shares no prefix. This offline tool does not submit workload prompts.


冷時TTFT=800msと入力10,000トークンは比較表示用の仮定。ウォーム値と費用は依頼仕様の固定値であり、実際の割引率やモデルの性能を証明しない。実課金は0ドル。モデル指定を変えても模擬数値は変わらない。

## モデルルーター模擬結果

# Model router benchmark (simulation)

Specification fixture prices; no API calls or billed cost. Input 1000 / output 0 tokens per task.

| Count | p50 ms | p95 ms | p99 ms | Estimated USD | Fixture classification accuracy |
|---:|---:|---:|---:|---:|---:|
| 1000 | 1200 | 2000 | 2000 | 0.912500 | 100.0% |

Latency is simulated inference latency (nearest-rank percentiles). Accuracy uses 8 labeled smoke fixtures, not an independent quality evaluation. Local routing duration is measured separately by load-test.


100件でもp50=1200ms、p95=2000ms、p99=2000ms。内訳はsimple=26、medium=50、complex=24、入力1000トークン/件で推定合計0.088900ドル。分類正解率100%は8件のラベル付きスモーク例を反復した結果であり、未知の実務データに対する精度ではない。実際のローカル判定処理時間はload-testのroutingLatencyMsとして別に返すため、実行環境によって変動する。

| ルート | モデル | 入力USD/1M | 出力USD/1M | 模擬推論ms |
|---|---|---:|---:|---:|
| simple | deepseek/deepseek-v4-flash | 0.15 | 0.60 | 500 |
| medium | moonshotai/kimi-k3 | 0.50 | 1.50 | 1200 |
| complex | openai/gpt-4o | 2.50 | 10.00 | 2000 |

単価は今回の仕様定数であり、現行料金の照会結果ではない。既存課金集計の単価は変更しない。

## APIと制約

- classifyTask(text)はsimple/medium/complex/unknownの文字列を返す。複雑な指示を優先し、simpleとmediumの混在、空文字、未知語、10万文字超はunknown。非文字列はエラー。
- routeTask(text, options)はunknownをmediumに変更し、分類・信頼度・モデル・費用・レイテンシを返す。信頼度はルールの定数であり校正済み確率ではない。
- estimateCost(route, tokens)は数値なら入力のみ、オブジェクトなら{ input, output }の両方を計算。unknownはmedium単価。負数・非整数・不明ルートは拒否。
- complexモデルはrouteTaskのcomplexModelまたはclassify CLIのMODEL_ROUTER_COMPLEX_MODELで指定。変更モデルの単価はcomplexPricingで明示しない限りnull。変更モデルの推論レイテンシもnullで、既定モデルの数値を流用しない。
- options.logFileを指定した場合のみJSONLへ追記。分類正誤はexpectedRouteを与えた場合だけ判定し、それ以外はnull。タスク本文は保存しない。
- loadTest(count, options)は最大10万件。options.tasksに{text, expectedRoute}の配列を渡せる。ネットワーク通信や待ち時間なしで模擬推論時間のnearest-rank分位点を返す。

## Orgiast提案生成への適用計画

1. 顧客情報から項目を抽出する処理をsimple、資料要約をmedium、提案全体の設計をcomplexに対応させる。初期段階はシャドー判定として既存処理と比較し、本番経路を変更しない。
2. 独立した実務タスクの正解ラベルを用意し、分類誤りと提案品質を人手で評価する。今回のスモーク例から品質向上を結論づけない。
3. 将来API計測が別途認められた場合、固定のシステム指示・出力スキーマを先頭に、顧客固有情報を末尾に配置する。共通全文・部分共通・共通なしの各条件で冷時/温時を対にし、モデル、提供元、トークン数、TTL、試行順、反復数を記録する。
4. リクエスト開始から最初の本文トークンまでをTTFTとして計測する。キャッシュ入力トークン/全入力トークンとOpenRouterのusage.costを記録し、課金情報が欠ける試行は実費不明として扱う。
5. 品質合格率90%以上・複数回の測定という既存routing-tableの基準を参考に、費用・レイテンシを比較する。採用判断後の既存ゲートへの接続は別変更とする。Claudeへの自動フォールバックは設けない。
