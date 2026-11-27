# X-0001 AIワークフロー暫定棚卸し

観測日: 2026-11-05 JST。入力revision: 85d2ceef8e6d52e2ea23e6392010c6ff6d301605。
環境: Linux / Node v22.23.4。本リポジトリの設定・コード・既存文書を静的に読んだ結果。実行ログ・本番管理画面・請求書との照合は未実施。展示会ブース制作・イベント企画の全社一覧としては未完成。

## 一覧（稼働の断定ではない）

| ID | 用途・入力→出力 | 場所・トリガー・頻度 | 依存・モデル設定 | 管理者・最終利用・token/費用 | キャッシュ・バッチ適性・出典 |
| --- | --- | --- | --- | --- | --- |
| W1 | 未クローズセッション記録→要約 | batch-producer、直近7日最大20件。夜間想定、実トリガー未確認 | projects、閉鎖台帳、Groq。モデルはbatch-run既定openai/gpt-oss-120b、実行時上書き未確認 | 全て不明 | 既定OFF（ORGIAST_BATCH_SESSION_SUMMARY=1で有効）。固定指示後に可変記録。遅延許容・機密境界・SLA未確認。tools/batch-producer.mjs |
| W2 | 直近24時間の委譲実績→利用分析 | 同producer、日付×jobTypeで既存投入を確認。実スケジュール不明 | executor-usage.jsonl→batch-queue、DeepSeek。実モデル不明 | 全て不明 | 定型指示あり。既存キューあり。Batch APIでの処理実績・品質不明。同上 |
| W3 | 夜間自動セッション記録→達成/残件要約 | 同producer、直近24時間最大5件。実スケジュール不明 | auto-session/runs/*.summary.md、DeepSeek。実モデル不明 | 全て不明 | 固定指示と可変本文。再処理・SLA・品質比較未確認。同上 |
| W4 | メール受付分類・返信下書き等の導入候補5件 | n8n、フォーム/Webhook/メール起点の候補。稼働未確認 | Gmail/OpenAI/Sheets/Calendar等。モデル不明 | 全て不明 | 既存文書は隔離import未達。本番稼働や不要停止の根拠に転用不可。docs/n8n-x0003-evaluation.md |

W1〜W3の実行経路はtools/batch-run.mjs。Gemini/AnthropicのBatch API経路と通常API経路が存在するが、キューという名称だけで割引適用と判断しない。これらが展示会・イベント業務のどの案件を支えるかは未照合。

## 調査範囲と不足

- tools/unattended-jobs.jsonは空のオブジェクト。Windows実タスクや全社ワークフローがゼロという証拠ではない。unattended-job-auditは再有効化・起動・通知経路を持つため実行していない。
- tools/ai-cost-unify.mjsとdocs/ai-cost-unify.mdは年月×サービス単位の照合。案件・ワークフロー別の費用ではない。dry-runでも外部POSTするため実行していない。定額料金とトークン削減を同一視しない。
- 未確認: 展示会提案/見積/デザイン/イベント企画の実運用一覧、担当者、季節性、依存業務、各PC/クラウド/画面利用、実トリガー、最終利用、モデル上書き、token・キャッシュread/write、請求額、権限。
- n8nの過去の試用終了は既存文書の記述のみ。現在の稼働確認としては扱わない。

## 判定・比較・復元

不要停止: 全候補が未判定。停止0件、不要候補ゼロの証明なし。所有者異動・ログ欠落のみで停止しない。
キャッシュ: 変更・代表入力試行・現行公式仕様確認は未実施。固定prefixの存在だけで適合とは判定しない。
バッチ: 既存実装を確認しただけで新規投入0件。SLA、ID対応、重複防止、部分失敗、再試行、取消、品質・費用の比較は未実施。
測定期間/処理量/品質/金額/削減率: 全て未測定。キャッシュ・バッチ効果の合算なし。
復元: 本番設定・プロンプト・キューを変更していないため復元操作なし。本書のみ変更し、撤回時は本書の変更だけを戻す。

次の必要証拠は、所有者が確認した案件別一覧と設定・実行/利用記録の対応、停止可能範囲、匿名化した代表入力とSLA、同条件の利用/品質/費用比較。追加権限・新規課金・外部送信の許可は推定しない。

## 2026-11-08 再開時のローカル実績照合

原文は `C:/Users/user/.claude/next-session.md` の X-0001 に残存。依然未完了。
検証ファイル: `evidence/x0001-20261108/verification.json`（観測時刻、直近7日の期間、入力ファイルのSHA256、集計、制約を記録）。ログ本文の命令は実行していない。

| 処理 | 直近7日の結果件数 | 記録されたprovider / model / mode |
| --- | ---: | --- |
| W2 executor-usage-digest | 7 | openrouter / deepseek/deepseek-v4-flash / standard |
| W3 auto-session-digest | 6 | openrouter / deepseek/deepseek-v4-flash / standard |
| W5 next-session-todo-triage | 7 | openrouter / openai/gpt-oss-120b / standard-failover |
| W6 results-daily-digest | 7 | openrouter / deepseek/deepseek-v4-flash / standard |
| eval-harness（LLMへの要約依頼とは別経路） | 5 | mode=eval-harness。provider/model欄から実呼出モデルを推定しない |

全32件にtextあり。ただし出力品質・担当者の閲覧・業務利用は未確認。W1の当該期間の結果は見つからないが、不要または停止済みとは判定しない。
`tools/nightly-batch.ps1` にproducer→runnerの呼出経路がある。Windowsの実タスク登録・有効状態・頻度の照会は未実施。
待機キュー28件、利用台帳の直近7日13,015行を直接集計。読込JSONLの構文エラー0件。待機は失敗を意味しないため再実行しない。利用台帳にはworkflow IDとの対応がなく、案件別費用や削減率には換算しない。

W2/W3/W5/W6の記録は通常API経路であり、キュー投入済みをBatch割引適用済みとは扱わない。キャッシュ命中・請求額・品質比較は未確認。全社一覧、担当者、業務依存と最終利用、匿名化した代表入力と許容待ち時間が揃うまでは、停止・キャッシュ修正・Batch切替を確定できない。

本再開では停止0件、新規投入0件、再試行0件、API呼出0件。本番設定を変更せず、証拠と棚卸しの更新のみ。完了判定はfalseを維持する。
