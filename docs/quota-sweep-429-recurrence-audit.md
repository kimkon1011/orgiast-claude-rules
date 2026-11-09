# Claude HTTP 429・連続延期の有限監査

対象handoff: `7c5815092275ce5c`。観測: 2026-10-25T05:54:43Z。対象コードrevision: `2d35c9f7d0e59f214bfbab20e22d6eb71c0b5ead`。製品コード変更なし。

Windows homeの `quota-sweep.jsonl` 候補を全47行走査した。Claude34件、JSONパース失敗0。範囲は2026-10-21T04:03:42.634Zから2026-10-25T02:53:11.283Z。44187 bytes、SHA256 `2967a181c5788bd4ad36884f364b2acc47156e0f394fed500b73db903343b4c4`。

| 行 | UTC | provider | outcome / stopOutcome | reason | resetsAt | ticks |
| --- | --- | --- | --- | --- | --- | --- |
| 44 | 2026-10-24T21:29:33.652Z | claude | deferred / deferred | HTTP 429による利用窓読取延期 | 1792881000000 | 2 |
| 46 | 2026-10-25T02:20:41.771Z | claude | deferred / deferred | HTTP 429による利用窓読取延期 | 1792899000000 | 1 |
| 47 | 2026-10-25T02:53:11.283Z | claude | deferred / deferred | HTTP 429による利用窓読取延期 | 1792899000000 | 3 |

行45はCodexのexhaustedで、Claude結果ではない。行43は対話セッション使用中の延期。直近Claude3件のHTTP429延期は窓resetをまたぎ、stateの `deferredStreaks.claude.count=3` と整合する。ログ対応は第3試行で照合済み。現行コードでは対話セッション使用中の延期をカウンタ対象から除外し、それ以外のdeferredで加算する。ただし当時プロセスの版は未確定。

走査末尾以後のClaude結果は0件。回復・再発なしとは判断できない。登録済みタスク実体によるhome/レーン確認、対象ログとの時刻対応、実運用revisionの確定が残る。429のみから原因を断定しない。API呼出し・実sweepは行っていない。

検証環境は `/usr/bin/node` v22.23.3。前回の厳密ゲート `node --test tools/` はMODULE_NOT_FOUND、終了1でテスト未収集。同一コードの失敗証拠を保持し、今回の文書変更では再実行していない。これは製品故障の赤ではない。原因に対応した赤→緑、指定ゲート成功、独立検査、PR包含確認は未達。push/PR/mergeはユーザー指示により行わない。

## 登録設定と対応ログの追加照合

2026-10-25の第3試行で登録済み `OrgiastQuotaSweep` XMLを読取り、`wscript.exe` → `.claude/tools/run-hidden.vbs` → Windows Node → `.claude/nightly-repo/tools/quota-sweep.mjs` を確認した。作業ディレクトリは `nightly-repo`、多重起動設定は `IgnoreNew`。現在の登録先HEADは `6457d7b2bb4f4331f4757aabad4356f7a5f39b59`。これは当時の実行revisionを証明しない。起動環境の `ORGIAST_HOME` は未取得。

主ログの02:20:41.791Zと02:53:11.593ZのClaude deferredは台帳の行46/47と対応する。02:49〜02:53にはretry 1/3、2/3、3/3が交錯している。要求ID/PIDがないため呼出系列の同定は未完了であり、並行要求を429の原因とは断定しない。新規API要求は行わず、前回以降のClaude結果も0件で回復判定不能。次は当時の実行版と呼出系列の識別が必要。

## 当時のディスクHEAD候補と呼出経路

第4試行（観測UTC 2026-10-25T05:59:59Z）でnightlyのHEAD reflog全732行を有限照合した。21:28Zの読取失敗開始を挟むcheckoutは20:54:04Zと22:04:03Zで、区間内HEAD候補は `8c40ba58e4c2908e0d47addd7df753cea90d32ff`。02:18Zと02:49Zを挟むcheckoutは01:34:03Zと04:04:03Zで、候補は `631b492fd5911ee0243eb6fd8345fbddf72febbf`。

両候補と調査revision `2d35c9f` の `tools/quota-sweep.mjs`、`tools/lib/quota-windows.mjs`、`tools/claude-plan-usage.mjs` を `git show` で取得した9件はすべて終了0、同じpathごとのSHA256は一致した。読取経路はsweepのwindows関数→readClaudeWindows→fetchClaudePlanUsage→OAuth usage API。成功時だけ15秒キャッシュし、失敗は保存しない。checkConditionsでは初回読取に加え最大3回、2秒・15秒・30秒待って再読する。

reflogはディスク上のHEAD履歴であり、起動済みプロセスのmodule読込時刻・dirty差分を証明しない。対象ログには要求ID/PIDやRetry-Afterがなく、要求系列とサーバ側制限理由を区別できない。版の候補は絞れたが、実行版確定・並行要求原因説の採否・429の原因特定は未達。今回の観測では台帳末尾を再取得しておらず、第3試行の有限範囲以後の回復状況は不明。製品修正・API実験・追加テストは行っていない。既存の指定ゲート未収集失敗は引き続き未解決。

## 429応答情報が失われる地点の最小実験

第5試行、観測UTC 2026-10-25T06:02:18.665Z、対象revision `2d35c9f7d0e59f214bfbab20e22d6eb71c0b5ead`。`fetchClaudePlanUsage` と `readClaudeWindows` に合成429応答を各1回注入した。headersのgetterは読取り時に例外を出す設定とし、結果は計2呼出し、ヘッダー読取り0回、両経路のreasonは `HTTP 429`、窓0件。assertは全成立、終了0、実ネットワーク要求0。合成認証ファイルは一時ディレクトリ内のみで作成・削除した。

欠落地点は `tools/claude-plan-usage.mjs:15` の非成功応答returnであり、Retry-Afterや要求IDを取得せずstatus文字列だけを返す。`tools/lib/quota-windows.mjs:52` はreasonのみを伝搬し、sweepの停止理由・台帳にもその文字列が残る。したがって現行記録からサーバが返した待機時間・要求IDを復元できない。これは診断情報の欠落の証明であり、429発生原因の証明ではない。応答にこれらのヘッダーが実在したかも未証明。

次の切り分けには、承認済みの通常実行で得る応答について、秘密を含まない許可項目とPID・ローカル要求系列・開始終了時刻を記録する設計が必要。ヘッダー未提供の場合も区別する。現時点では情報欠落と429原因を混同した製品修正は行わない。台帳末尾の再取得・実API実験・追加ゲートは未実行で、既存ゲート未収集失敗を保持する。

## 次回の有限観測設計（第6試行）

観測UTC 2026-10-25T06:03:52Z、対象revision `2d35c9f7d0e59f214bfbab20e22d6eb71c0b5ead`。これは未実装の設計であり、実物429の追加観測・原因解消の証拠ではない。

観測点は取得層のfetch直前・直後、sweepの15秒キャッシュ判定、checkConditionsの再読判定の3か所とする。取得層だけではキャッシュhitと呼出理由が見えず、sweepだけでは応答ヘッダーが失われる。現在の再読待機は2000/15000/30000ms、成功時キャッシュTTLは15000msである（静的照合終了0）。

| 記録項目 | 型・制限 | 用途 |
| --- | --- | --- |
| runId / PID / requestSeq | ローカル生成ID・整数、token由来は禁止 | 同一プロセス内の系列。PID単体の再利用を避ける |
| startedAt / endedAt / elapsedMs | UTC ISO時刻・単調時計差分 | プロセス間の時刻ずれと同一プロセス内重複を区別 |
| caller / retryIndex / scheduledDelayMs | 固定enum・有界整数 | 初回・再読と予定待機を区別 |
| cacheState / cacheAgeMs | hit/miss/expired・数値 | API非起動を独立イベントとして記録 |
| status / transportError | HTTP整数または固定エラー分類 | 429と401/403・通信失敗を区別 |
| retryAfter | missing/invalid/seconds/date、解釈後の値のみ | サーバ待機指示の有無と実待機の比較 |
| requestIdPresent | booleanのみ | サーバ識別子の存在確認。値自体は保存しない |
| sourceRevision / sourceDigest | 起動時のrevisionと対象3ファイルのdigest | dirty差分を含む読込元の確認。既存起動済みプロセスへの遡及証明は不可 |

Authorization・Cookie・資格情報・応答本文・全ヘッダー・任意エラーmessageは記録しない。Retry-Afterは長さ上限を設け数値またはHTTP-dateとして解釈し、不正値をそのままログへ転記しない。メタデータは既存reason文字列と分離し、既存の延期分類・再試行回数・待機・認証を変えない。観測追加が失敗しても元の戻り値を維持する。

有限実験はfake fetch・fake clock・合成資格情報で行う。429→429→429→429は4要求と待機2000/15000/30000ms、子実行0を確認する。429→200では回復窓取得とTTL内hitの要求0増加を確認する。401/403は各1要求・再読0。二つの保留Promiseで要求区間の重なりを作り、別runIdと同一runIdの重複を区別できることを確認する。ヘッダー欠落・不正・巨大値、sink例外、秘密のダミー値が出力にないことも確認する。これらは次回の受入条件であり、本試行では未実行。

同一runIdの区間重複は局所並行を支持するが、429との因果は証明しない。Retry-Afterが実待機より長い場合は待機不足仮説を支持する。要求の重複なし・待機指示遵守でも429なら局所並行説のみでは説明できない。ヘッダー欠落や他クライアントの観測不能があればアカウント共有・サーバ側制限は判定不能とする。実運用の起動・監視ジョブ・API連打は行わず、通常実行から得られる有限範囲の承認済み記録が必要。現在の入力ではその記録がないため、根本原因と原因固有修正は引き続き未達。

## 第7試行: 待機指示の判別限界の合成確認

UTC 2026-10-25T06:06:17.240Z、取得層revision `2d35c9f7d0e59f214bfbab20e22d6eb71c0b5ead`。合成資格情報とfake fetchでHTTP 429を固定し、Retry-Afterを欠落・2秒・120秒・不正値の4通りに変更した。各ケースは要求1、ヘッダー読取り0、同一結果 `{available:false, reason:"HTTP 429"}`。assertによる検査終了0、実API要求0。再現スクリプトと出力はローカル `.loop/quota-sweep-codex-7c581509-007-probe.mjs` / `007-probe.log` に保持。

この結果は現在の結果形式から待機指示の有無・長さを復元できないことを示す。実物サーバが120秒を返した証拠でも、待機不足が実物429の原因である証拠でもない。既存台帳を再読するだけではこの競合仮説を判別できないため、次手は前節の有限観測仕様の実装と合成回帰である。実物原因・回復・指定ゲート・PRは未達のまま。製品コード変更なし。
