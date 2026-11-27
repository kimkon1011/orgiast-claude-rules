# ふわ向け Claude ペース日報

毎朝07:30 JST、既存の日報ジョブ（011、011の台帳が古い場合は018）が、アカウントの消費ペース・当日のグロボ使用量・次の仕事・PC登録状況を機械可読な台帳として残す。LLM APIは呼ばない。アカウントに属するPCをまとめ、共有枠の消費量をPC数で重複加算しない。

## 置き場所と読み方

- 日付別: `reports/claude-pace/YYYY-MM-DD.json` と同名の `.md`（日付はJST）。
- 最新: [latest.json](https://github.com/kimkon1011/orgiast-claude-rules/blob/main/reports/claude-pace/latest.json)。
- ふわの読取先: [raw latest.json](https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/reports/claude-pace/latest.json)。非公開リポジトリでは認証済みのリポジトリアクセスを使う。トークンをURL・日報に書かない。
- Drive: 既存の「AI共通ノウハウ（Gemini・ChatGPT・Claude用）」配下 `claude-pace/claude-pace-YYYY-MM-DD.md` と `latest.md`。共有ハブIDとフォルダ名は `portable-knowhow-push.mjs` の定数を再利用する。日報末尾にGitHubの3ファイル・raw・DriveのURLを出す。

ふわは最初に `schemaVersion === 1` と `date` / `generatedAtJst` を確認し、古い台帳を今日の計測として扱わない。`null` は未計測・未確認であり、0ではない。`grokbot.received === false` のときは `note` の理由を表示し、前日分で補完しない。`pcs` / `unmeasured` を確認して、共有枠を計測できても全PCが計測・登録済みとは判断しない。PR経由の配信中はmainのURLが更新前の場合がある。

## JSONの項目

正式な構造は [日報スキーマ](claude-pace-report-schema.json)（draft 2020-12）。日時は同じ瞬間のJST（`+09:00`）とUTC ISO（`Z`）を必ず対で格納し、不明なら両方 `null` にする。

| 項目 | 意味 |
|---|---|
| schemaVersion / date | 構造の版 / 対象となるJST日付 |
| generatedAtJst / generatedAtIso / generatedByHost | 生成時刻の対 / 実行PC |
| targetLandingPct / dailyTargetPct | 週の着地目標（通常90%）/ 日次目安12.9% |
| accounts[].account / pcs | アカウント / 設定と観測で判明した所属PC |
| fiveHour / sevenDay | usedPercentとresetsAtJst / resetsAtIso。取得できない値はnull |
| elapsedRatio | 7日枠の経過率（0〜1） |
| previousDayConsumedPt | 約24時間前（±6時間）との7日枠使用率の増分。比較元がない・枠を跨ぐ・使用量減少ならnull |
| dailyTargetDeltaPt | 前日消費 − 日次目安 |
| targetLinePct / deltaPt | 目標線（通常90×経過率）/ 使用率 − 目標線 |
| effectiveTolerancePt | 許容幅。既定はmax(5, 10×(1−経過率)) |
| status / statusJa | behind=遅れ、onpace=ちょうど、ahead=進みすぎ、final-push=残り10%モード、stopped=停止（97%）、unmeasurable=計測不能 |
| projectedLandingPct / unusedForecastPt | 使用率÷経過率（開始直後はnull）/ 100−予測着地。負値は超過見込み |
| todayTargetPct / hold / actionsTaken | 今日の目安 / 台帳の保留フラグ / 台帳の措置・判断記録（本レポートが起動・停止したとの意味ではない） |
| codex | 参考のwindow名とusedPercent |
| pcs | host、account、当日計測の可否measured、失敗reason、最後の観測時刻の対、登録確認registered |
| grokbot | 当日入力の受領有無、週使用量・リセット、Claudeと同じ判定結果、従量の使用USD・上限USD・リセット、自己実行数・委譲数、note |
| nextTasks | 残り10%に回す上位3件。id / host / priority / title |
| newOfferings | 着手済みのサービス・商品。id / rank / host / title / state |
| unmeasured | 計測できなかったhostとreason |

当日計測のないアカウントはaccountsに古い数値を載せず、PC単位で未計測を示す。グロボ未受領時はreceived=falseとnote以外をすべてnullにする。

## グロボの入力

グロボは毎日 `reports/claude-pace/grokbot/YYYY-MM-DD.json` を更新する。[入力スキーマ](claude-pace-grokbot-schema.json)に従い、date / weeklyUsedPercent / weeklyResetsAtが必須。reset日時は数値オフセット付きISO8601（例: `2026-12-02T14:42+09:00`）。selfExecutedTasks / delegatedTasksは非負整数またはnull。onDemandUsd / onDemandLimitUsd / onDemandResetsAt / noteは省略可能。

初回の `2026-11-27.json` はグロボが2026-11-27 21:52 JSTに実測した値。当日ファイルがない、壊れている、dateが一致しない場合は理由付きの「グロボ分 未受領」とする。昨日のファイルは読まない。

## PC登録結果

`reports/claude-pace/registration.json` は `{ "updatedAt": "...", "hosts": { "000": { "registered": true, "checkedAtJst": "...", "note": "" } } }` の形。registered=trueは登録済み、falseは未反映（noteで理由を表示）、欠損・読取不能・PCの記録なしはnull／未確認。日報は登録操作を実行しない。

## 配信と障害時の動作

`claude-pace-report.mjs` の本番実行からpublishを呼ぶ。`ORGIAST_HOME`（なければ実ユーザーのhome）配下 `.claude/claude-pace-reports-repo` を専用クローンとして使う。他作業には使わない。既存クローンはoriginとルートを検証し、fetch → reset --hard origin/main → mainへcheckout。上記のJSON・md・latest.jsonだけを明示してcommitし、mainへpushする。

保護ブランチまたはnon-fast-forwardで拒否された場合だけ `report/claude-pace-YYYY-MM-DD` をpushし、既存の同日PRを再利用するか作成してauto-merge（squash）を設定する。フォールバックを戻り値とmarkdownに記録する。認証など別の失敗を保護ブランチ扱いしない。Driveには同じmarkdownを2ファイルに保存し、失敗してもdriveErrorを戻り値・リポジトリのmarkdown・通知に残す。ログに認証情報を含むエラー全文は保存しない。

両CLIの `--dry-run` はローカル台帳と当日の入力だけを読み、clone・commit・push・Drive認証/書込・通知を一切行わない。publishのdry-runは予定3パスと全文を標準出力に出す。本番スケジュールの登録方法は既存のまま。

新規依存は使用しない。`tools/lib/json-schema-check.mjs` はこのスキーマに使用するtype（配列でnull許容）/ required / properties / items / enum / additionalProperties / minimum / patternを検証する。一般のJSON Schema全機能の検証器ではなく、未対応キーワードはエラーにする。
