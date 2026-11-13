# X の AI 活用 tips 改善ループ

`nightly-batch.ps1` が `x-ai-tips-collect.mjs` → `ai-news-triage.mjs` の順に実行する。X の情報は未検証の提案として扱い、既存の Web 裏取り・採否判定を通して `next-session.md` の残TODOに合流する。自動的に本番設定を変える機能ではない。

## 収集とデータ

- `config/x-ai-tips-topics.json` の各テーマについて、xAI `/v1/responses` に `model: grok-4.6`、`input`、`tools:[{type:"x_search"}]` を1回送る。既定は3目的×日英の6テーマ。Claude API や別プロバイダーへのフォールバックはない。
- 直近48時間の再現できる手順・数値を最大5件/テーマ抽出。宣伝・感想だけ・出典不明の数値を除外するよう指示する。投稿URL、投稿者、要約、手順、目的、投稿時刻、likes を検査し、likes 不明または既定10未満の投稿も除外する。反応数と投稿内容はモデル取得値なので、事実確認は既存 triage が担う。
- `~/.claude/ai-news-proposals.jsonl` に `X-0001` 形式のID、`status:pending`、`confidence:low`、既存互換 category、`purpose:cost|site|business`、`source:x` を追記する。evidence に投稿URL・投稿者・要約を残す。
- `~/.claude/x-ai-tips/state.json` に正規化URL、内容ハッシュ、最終連番、日別予算、週次配送結果を保存する。既存提案のタイトルは処理状態に関係なく照合。URLは twitter.com/x.com・投稿者名・クエリ文字列の違いを吸収する。
- 投稿への反映後に state を保存し、各応答後に提案ファイルを読み直す。state 保存直前の停止でも既存提案のURL・ハッシュから復旧できる。collector 同士は `collect.lock` で排他する。既存 LINE/triage はこのロックに参加しないため、提案ファイルを書き換える処理を別プロセスで同時実行しない。夜間バッチは順次実行する。
- ホームは `ORGIAST_HOME` または OS のホーム。キーは `XAI_API_KEY`、次いで `.claude/xai.env` を `readEnvValue` で読む。キー未設定は `skip:キー未設定` / exit 0。

## 費用と失敗

既定は JST の暦日ごとに最大8 API呼び出し・推定2ドル。同じ日に再実行しても予算を共有する。既定6テーマなので通常は6回。各リクエスト前に0.25ドルを予約し、残額不足なら送信しない。HTTP失敗、タイムアウト、usage欠落でも予約額を残す。プロセス停止前にも回数と予約を保存する。

応答に `usage.cost_in_usd_ticks` があれば `1e10` で割った請求額を優先する。ない場合は input/output tokens と `server_side_tool_usage_details.x_posts_fetched/x_users_fetched` を設定単価で推定する。トークン単価の既定3/15ドル（100万トークン当たり）は予算用の仮定であり、モデルの確定料金ではない。検索項目単価は投稿0.005ドル、プロフィール0.01ドル。必須usage不足は打ち切る。

参考: [xAI Cost Tracking](https://docs.x.ai/developers/cost-tracking)、[X Search](https://docs.x.ai/developers/tools/x-search)、[Pricing](https://docs.x.ai/developers/pricing)。単価は設定で更新できる。

**上限は応答後の費用判定と次のリクエスト停止であり、請求額の厳密なハードキャップではない。** サーバー側検索の取得件数により1リクエストが予約額を超えることがある。超過応答は提案を保存せず打ち切り、費用を記録する。実請求を厳密に制限する場合は xAI 側の利用枠も設定する。

`runs.jsonl` に各呼び出しの usage、費用、予約か実測か、テーマ、累積回数・費用、結果を記録。401/429/5xx を含むHTTP失敗は再試行せず停止。通信は120秒で打ち切る。壊れた state は初期化せずエラーにする。ログにはキーやAPIエラー本文を出さない。

最終行は `ok:取得N件 追加M件 重複K件 費用$X.XX` / `skip:...` / `error:...`。error は exit 1。夜間ログは `x-ai-tips-collect.log`、ヘルス監視は26時間。

## 週次まとめ

JST 月曜の収集前に、過去7日間に作成されたX由来提案の現在の採否を集計する。その夜に新規追加する提案は次回の対象。目的別の採用・却下・未処理件数と、全目的を通じた採用上位5件（confidence、新しい順）を `notify-kim.mjs` の `notifyKim` に定期情報として1回渡す。採用は `done && adopt===true`、却下は `rejected`。

既存の通知許可リストに従い、Discord または kim の session-inbox に配送する。配送経路を強制変更しない。本文と配送結果は state に保存し、配送済み本文全文（添付なし）は実行ログに表示する。dry-run は通知しない。

配送直前に週の予約を保存するため、配送直後のクラッシュでも同じ月曜に二重送信しない。配送不明・失敗の場合もその週は自動再送しない（最大1回を優先）。state の weekly.status / delivery で確認する。

## 実行・テーマ変更・停止

```sh
node tools/x-ai-tips-collect.mjs
node tools/x-ai-tips-collect.mjs --dry-run --limit 1
node --test tools/x-ai-tips-collect.test.mjs
```

`--dry-run` は実APIを呼ぶため課金されるが、提案・state・ログ・ロックを書かず、通知もしない。既存の当日予算は読み込むが、その実行分は永続化しない。検証用途に限定する。`--limit` はその実行で検索する先頭テーマ数を制限する（永続する1日上限は maxCalls）。

テーマの追加・削除は設定の `topics` 配列で `{ "purpose":"site", "query":"検索テーマ" }` を編集する。日本語と英語を別テーマとして管理する。`maxCalls` を超えるテーマはエラーで停止するので、テーマ順と費用枠も確認する。`maxCostUsd`、`reservePerCallUsd`、`minLikes`、`estimatedRates` も同じ設定に置く。

止めるには `enabled:false` にする。夜間ジョブ自体は動いて `skip:設定で停止中` を残す。再開は true に戻す。予算や重複記録を消す必要はない。クラッシュで `collect.lock` が残った場合は稼働プロセスがないことを確認してロックのみ削除する。state を削除すると当日の予算・週次配送予約も失われるので削除しない。
