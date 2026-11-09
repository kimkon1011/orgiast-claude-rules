# X-0011 信頼度ベース分類器

展示会ブースへの問い合わせをリード資格・緊急度・標準/特別仕様の3次元で分類する。呼び出しは既存の tools/llm-ask.mjs 経由。Claude API と Claude モデルへの分岐は追加しない。

## 実行

```sh
node tools/confidence-classifier.mjs --mode generate-samples --count 12
node tools/confidence-classifier.mjs --mode classify --input "展示会のブース制作の見積もりをお願いします。2026年12月開催の国際ロボット展に出展予定です。"
node tools/confidence-classifier.mjs --mode evaluate --samples 12
node --test tools/confidence-classifier.test.mjs tools/llm-ask.test.mjs
```

各モードの標準出力は JSON。エラーは標準エラー、終了コード1。evaluate は一部失敗でもレポートを保存して終了コード1を返す。成果物パスはカレントディレクトリに依存しない。

## 判定と品質

Groq（openai/gpt-oss-120b）を優先し、失敗・不正JSONの場合だけDeepSeekへ切り替える。--prefer-provider と --no-fallback によりカテゴリ表や汎用フォールバックによるモデル変更を防ぐ。DeepSeekは既存設定のOpenRouter経由。GeminiキーがなくOpenRouterキーがある場合は既存ヘルパーが同じGeminiモデルへ転送する。

最低信頼度0.9以上なら採用。0.3以上0.9未満なら Gemini Flash、0.3未満・cheap 全滅なら Genspark GPT に送る。Gemini の失敗・低信頼度も Genspark に送る。最終結果が0.9未満なら needs_review=true。全モデル失敗は分類結果を捏造せずエラーとする。

JSONのラベル・型・信頼度の範囲を検証し、不正応答も呼び出し失敗として扱う。MarkdownのJSONフェンスは受理する。uncertain を含む応答は保守的に最低信頼度0として再判定する。

classifications は dimension / value / confidence の配列。lead_qualified は boolean。confidence は最終結果の最低値、cheap_confidence は安価段階の最低値、escalated は上位段階への移行、attempts は呼び出し先と成否。

緊急度は基準日から14日以内=high、15〜60日=medium、それ以外・過去・日付不明=low。月だけの場合は1日とする。単件分類の基準日は実行時のUTC日付。合成評価は2026-11-09を固定基準日とする。

## サンプルと評価

既定では data/booth-projects.json の3案件から各4件、合計12件の合成メールを作成。現在の samples.jsonl は並行作業で48件に増えており、今回の評価対象は先頭12件。会社名・イベント名・区画を使用し、見積もり・独自制作・資料質問・プレス掲載の4種を作る。開催日はseed=11の疑似乱数で設定し、文面とは別に正解ラベルを生成する。countを増やした場合は案件とテンプレートを反復するため、独立した実データにはならない。

評価は全3次元一致の精度と各次元精度を計算する。分母は全件、呼び出し失敗は不正解。エスカレート率には上位モデル呼び出しが失敗した件も含む。自己申告信頼度は未校正。実問い合わせを使った独立評価と全高品質モデルとの比較は別途必要。

## 費用と分離

llm-ask.mjs に --usage-file を追加。--no-persist との組み合わせは共有状態を変更せず、明示した使用量ファイルだけ記録する。既存の --no-persist 単独の挙動は維持する。子プロセスごとの executor-usage.jsonl を読み取り、run_id / call_id / sample_id を付けて cost-log.jsonl に追記する。並行実行の費用が混入しない。

各行に provider / model / tokens / usd を保存。APIや既存台帳が金額を返さない場合は usd=null、使用量ログ自体がない場合は tokens=null として失敗記録を残す。推測料金は補完しない。既存Gemini台帳のusdは設定済み単価による計算値であり、請求明細との照合値ではない。費用行に不明があれば総費用はnull、評価が全件成功しなければ1000件換算もnullとする。

入力はJSONを一時ファイルへ書き、--prompt-file で渡す。シェル文字列の展開は行わない。一時プロンプト・使用量台帳・標準出力は終了時に削除。タイムアウトはモデル20秒、子プロセス25秒。標準出力のパイプ取得を制限する実行環境にも対応するため、一時ファイル経由で受け取る。

## 今回の実行状況

評価結果は evaluation-report.md、使用量・失敗記録は cost-log.jsonl を参照。必要なAPIキーがこの実行環境では未設定で、実モデルの精度・費用目標は検証できていない。98.8%、22%、$0.88/1000件、4.4倍は指示書の目標であり、達成を主張しない。

## テスト結果（2026-11-09）

- 分類器: 11/11 pass。0.3/0.9境界、各次元の最低値、uncertain、不正JSON、安価モデル障害、上位モデル障害、最終要レビュー、サンプル再現性、失敗を含む集計、実CLI＋模擬HTTPの結合を検証。
- 既存 llm-ask: 9/9 pass（下記の環境用アダプターを使用）。
- 通常の node --test は、この環境の子プロセスパイプ制約で出力を取得できず失敗した。子プロセスを省略する --test-isolation=none と、テスト用のファイル経由 stdio アダプターで再実行した。アダプターは実HTTPを模擬しない。HTTPの模擬は各既存テスト自身が行う。
- 構文チェックと変更対象の git diff --check は成功。
- 指定文面の実モデル classify は終了コード1。Groq / OpenRouter / Gemini / Genspark のキー未設定を確認。12件の評価も全件失敗し、終了コード1。モデルの精度0%と解釈せず、実評価不能として扱う。

再現コマンド:

```sh
node --test --test-isolation=none tools/confidence-classifier.test.mjs
node --import ./outputs/X-0011/test-stdio-adapter.mjs --test --test-isolation=none tools/llm-ask.test.mjs
```

生の出力: test-results.txt、llm-ask-test-results.txt、classify-smoke.txt。
