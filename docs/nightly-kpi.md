# 夜間KPI

`node tools/nightly-kpi.mjs --date YYYY-MM-DD --format=text` は、前日18:00から当日09:00（ローカル時刻、両端を含む）の無人作業を集計する。結果は `~/.claude/nightly-kpi/YYYY-MM-DD.json` に原子的に上書きし、異常時は `next-session.md` の先頭の残TODOへ重複なしで改善項目を起票する。`--dry-run` は両ファイルを書き換えず、`--no-notify` はDiscord通知を止める。

主KPIは次の3つ。

- `closeRate = closedOvernight / backlogAtStart`（消化率）
- `noOpRate = noOpSessions / sessions`（空回り率）
- `netSavingUsd = modelSavingUsd - wastedUsd`（純コスト削減効果）

分母が0なら率は `null`（不明）とする。消化量 `closedOvernight` は完了日が対象日または前日のTODO数。完了時刻は引き継ぎ票に無いため、前日付は夜間開始後に完了したものとして扱う。`backlogAtEnd` は重複除去後の未完了数、`backlogAtStart = backlogAtEnd + closedOvernight`、`netBurnDown = backlogAtStart - backlogAtEnd` である。日付なしの✅は `dateUnknown` に分離する。

品質指標はセッションの成功・失敗・timeout、要約と最終応答から判定する空回り、近似一致クラスタによるテーマ集中率を含む。比較時は、参照先や進捗などの補足になりやすい括弧内を除き、英数字の連続を1語、日本語を文字bi-gramとしてJaccard係数を計算する。テーマは同じ仕事の言い換えを拾うため `TOPIC_SIMILARITY_THRESHOLD = 0.5`、TODO重複は似た別件の誤統合を避けるため厳しく `TODO_SIMILARITY_THRESHOLD = 0.7` とする。TODOは完全一致で畳んだ後に近似一致でも畳み、クラスタ内に✅が1つでもあれば完了扱いにする。`duplicateTodoLines` は両段階で除去された行数である。

夜間バッチはログ不在を `batchRan: false`、サマリ行不在を `batchCompleted: false` とし、不明を正常に丸めない。Windowsのスケジュールタスク情報は取得できない環境では `null` になる。

コスト値はすべてlist価格換算であり、実請求額ではない。`nightCostUsd` は実行結果の総コスト（欠落時はモデル別トークンから算出）、`supervisorEquivalentUsd` は同じトークン量をOpus 5で処理した反実仮想、`modelSavingUsd` は両者の差、`wastedUsd` は空回り分、`savingPerClosedTodo = netSavingUsd / closedOvernight` である。`humanMinutesSaved = closedOvernight × セッション所要時間中央値` は「人間の作業時間」ではなく、無人で消化した実時間の中央値を使う参考値である。
