# PR #1576 Windows通知の検証記録

- 取得日時: 2026-11-05T23:58:52.063192+09:00（Asia/Tokyo）、試行 toast-v1-002。
- 環境: DESKTOP-04U31RG / WSL2、作業ツリー quota-sweep/20261105-1451-codex-mw3nz1oo。
- 対象版: 8e8c442ac81e8f7a5cafc510f1853fa227d56ca1。開始時の追跡・未追跡変更は git status でなし。
- PR #1576: a54cc105207eea38e72fc9d41aa69d3317376355（ローカルcommit件名）。`node tools/commit-landed.mjs a54cc105207eea38e72fc9d41aa69d3317376355 --json` は landed=true / via=ancestor。ヘルパー終了値は0=取込済み、1=未取込、2=実行エラー。docs/PC名簿.md:12はDESKTOP-04U31RGを作業用019/nishi-PCに対応付ける。実稼働タスクのパス・SHA・実ユーザーの対応は未確認。

## 観測と限界

2026-11-05の既存ファイルだけを読み、本文・宛先を除いた識別子、時刻、配達結果をローカル証跡へ保存した。通知、再送、台帳更新、設定変更は行っていない。

対象セッション5fd545ffの `ki-20261105142520-1feb` は、done-inboxログの at=2026-11-05T14:00:01.798Z、kim-inboxの createdAt=2026-11-05T14:25:20.390Z、台帳のdoneInboxIdが一致する。_owner.jsonlにも同じsessionId・atのイベント fa96b0b4-af8c-4ebb-90d8-fc7351fa3d35 がある。ログatは巡回引数nowであり、Windows表示時刻とは扱わない。同セッションには別のdone受領IDもあり、sessionIdだけでは同一約束の重複を確定できない。

現行コードの watch notifyDone は usesKimDoneInbox 条件で deliverDoneInbox→受領記録→return となり、下段のsendOwnerToastへ進まない。hasDoneInboxReceiptで再送を抑止し、配達側はrowKeyから安定dedupeKeyを作り、保存後に読戻す。これは完了のKim inbox経路がトーストを呼ばない静的な欠落の証拠であり、実稼働版を特定できないため実機不達の確定ではない。

期限切れcheckは再開後再確認し、未達時にoverdue_reportedへ遷移、保存済み最終報告をnotifyOwner(kind=automatic)へ渡す。overdueReportedAtなしは報告のみ再試行する。notifyOwnerはrouteOwnerDmによるdeferred、session-inbox成功、messageId付きDM成功ならトースト前に戻る。トーストはlocal owner一致時のfallbackで、notifyChannels条件にも従う。通常完了の追加トーストはowner一致を要求し、quiet hours・通知停止・受領済みも分岐条件になる。これらの条件が対象実機で成立したという証拠は未取得。

日次進捗は朝digestの12時間以上先のcheck付き行から生成され、owner/JST日付で重複抑止される。deadlinePrefixありはdeadline-digest inbox、それ以外はnotifyOwner(kind=digest)。2026-11-05T08:00:01.492Zの既存digestログに delivered=toast / ok=true / toastExitCode=0 があるが、当該日次要約の本文対応とWindows受領・表示は未確認。終了0を表示成功には数えない。

sendOwnerToastは現行版ではWindows Forms NotifyIcon.ShowBalloonTipを利用する。autopilot-toast.ps1のToastNotificationManagerとは別経路。PowerShellでWindowsの機名・対話性・sessionIdを読む操作は終了1、`WSL ERROR: UtilBindVsockAnyPort:317: socket failed 1`。Windows側の通知履歴・実ユーザー・対話セッションは取得できず、完了・期限超過の表示可否はともに未確認。

## 指定ゲート

`node --test tools/*.test.mjs` を上記revisionで実行。トップレベルok=3564、not ok=0の時点以降、約7分出力更新なし。2026-11-06（JST）の手動境界でCtrl-C中断、終了130を実行ツールで確認した。最終集計なし、全件数・skip差分は不明。C4未達。旧目的の別revisionにも同じgate-guard-contract後の中断履歴があり、次回はgate-readonly以降を診断し、同じ全体ゲートの無変更再試行を避ける。

## 判定と次の最小観測

C1はローカル取込と静的経路のみ確認、実稼働版の対応が残る。C2は未確認。C3はinbox受領とtoastを分離し、静的な重複抑止条件を確認したが、実機抑止原因は未確定。C4は中断・未完走。C5はローカルstate保存・読戻しで別途記録する。実機証拠なしのため検証未完了。

次回はnishi-PCの既存タスク定義から実行パスと版を特定し、同一イベントのWindows側受領・通知履歴・表示証跡を読み取る。完了と期限超過をそれぞれ相関し、日次要約・最終報告の配達先も確認する。WSL接続エラーを迂回せず、既存証拠が得られる環境で観測する。新規通知には別途明示的な依頼が必要。製品コードの修正は今回の範囲外。

## 追加診断 toast-v1-003（2026-11-06 JST）

同じ対象revision 8e8c442ac81e8f7a5cafc510f1853fa227d56ca1、WSL2でゲート停止箇所を静的に調査した。取得時刻は2026-11-05T15:09:06.557Z。gate-contracts.mjsのdiscoverGatesによるメタデータ読取りでは73ゲート、readonly fixtureは16コマンド。gate-readonly.test.mjsは各組合せをBash/PowerShellの2種でspawnSyncするため、計2,336子プロセス、各タイムアウト10秒となる。多数の逐次起動で長時間無出力となる可能性があるが、前回の停止原因や所要時間を確定する証拠ではない。今回は子プロセスを起動せず、全体ゲートの無変更再送もしなかった。C4は引き続き未達。

Windows接続の回復を示す新証拠はなく、同じ失敗操作は再送していない。C1の実稼働版、C2の完了・期限超過の表示、C3の実機抑止条件は未確認。次はWindows側既存証跡が読める環境で稼働版とイベントを相関する。ゲートは前景実行が可能な時間枠でgate-readonly単体の所要時間・完走を観測した後、指定全体ゲートの最終集計を取得する。通知再送・コード変更は行っていない。

## 追加診断 toast-v1-004（2026-11-06 JST）

環境WSL2、対象版8e8c442ac81e8f7a5cafc510f1853fa227d56ca1。2026-11-05T15:11:40.574050Zから、`node --test --test-name-pattern="^answer-canonical-gate: full readonly corpus" tools/gate-readonly.test.mjs` を前景実行した。先頭1ゲートの16コマンド×Bash/PowerShellの32組は終了0、tests=1/pass=1/fail=0/skipped=0、総所要10.461秒、当該subtest所要3696.749394ms。コマンド文字列はhook入力であり外部サービスの操作として実行されない。ログは.loop/toast-v1-004-sample.log、環境・版・取得時刻は同-sample.jsonに保存。

前回の静的な子プロセス数に対し、先頭ゲートが単独では完走することを追加確認した。残る72ゲートや全体実行の停滞原因・所要時間は未確認で、単純な外挿やC4合格は行わない。指定の全体ゲートは今回再送していない。Windows接続回復の証拠はなく、同じ接続失敗操作や通知再送は行っていない。C1の実稼働版、C2の完了・期限超過表示、C3の実機抑止条件、C4の全体完走は引き続き未達。

2026-11-05T15:11:58.052906ZにPath.resolveとos.statvfsでGit実体を読取り、filesystemReadonly=trueを確認した（.loop/toast-v1-004-git-boundary.json）。Git書込み境界を迂回しない。次はWindows側既存証拠へのアクセス回復と全体ゲートの前景完走が必要。製品コード・テスト・設定・通知状態の変更なし。

## 追加観測 toast-v1-005（2026-11-06 JST）

対象版8e8c442ac81e8f7a5cafc510f1853fa227d56ca1、WSL2、取得2026-11-05T15:14:05.708545+00:00。既存Windows側証拠の所在をディレクトリ列挙で確認した。ユーザーのNotifications配下にwpndatabase.dbとWAL/SHMが存在する。DB本文・イベント・受領・表示は未取得であり、存在を表示成功と扱わない。Windows/System32/Tasksの列挙はPermissionError errno=13。タスク取得にはアクセス可能な環境が必要で、対話セッションや通知権限の不足を原因とは確定しない。PowerShellの既知失敗は再送していない。

静的照合: auto-progress-digest.mjs:337–359の日次進捗は朝のowner/JST日付で抑止され、deadlinePrefix時はsession-inboxへ、それ以外はnotifyOwnerへ渡る。成功判定は配達種別で、Windows表示の独立確認ではない。notify-owner.mjs:72以降はNotifyIcon.ShowBalloonTipを使用するため、autopilot-toast.ps1のToastNotificationManager向け履歴だけで否定判定できない。今回の所在確認によりWindows側既存証拠への候補を追加したが、DBの方式・対象イベント・稼働版との対応は未確認。

C1実稼働版、C2完了/期限超過の表示、C3実機抑止条件は未達。C4は前回の全体ゲート終了130のまま。今回は実機証拠の所在の独立観測を選び、全体ゲート・単体サンプルを再実行していない。C5はstateの引継ぎ保存・読戻しで記録する。製品変更・新規通知・別ループ・バックグラウンド子プロセスなし。証拠は.loop/toast-v1-005-diagnostic.json。Git実体はstatvfsで引き続き読み取り専用を確認。

## 追加観測 toast-v1-006（2026-11-06 JST）

対象版8e8c442ac81e8f7a5cafc510f1853fa227d56ca1、WSL2、取得2026-11-05T15:16:18.070769+00:00。既存Windows通知DBをSQLite mode=roとquery_onlyで開き、sqlite_masterおよびNotification/NotificationHandlerの列メタデータのみ取得した。Notification、NotificationData、NotificationHandler等の8テーブルが存在する。通知本文・宛先・対象行は取得していない。証拠は.loop/toast-v1-006-diagnostic.json。DBを読めることを確認し、次の観測候補を所在確認からスキーマ照合まで進めた。

対象done/overdueイベントとの相関、実稼働版、実ユーザー・対話セッション、Windows表示はいずれも未確認。NotifyIcon経路はDBだけで否定できない。C1〜C3は未達、C4は全体ゲート終了130のまま。新規通知や同じ失敗操作の再送、ゲートの再実行はしていない。次は対象アプリのハンドラーと対象日時・イベントの安全な限定抽出が可能かを照合し、NotifyIconについては独立したWindows側の表示証拠を取得する。Git実体はstatvfsで読取り専用のままと確認。製品コード・テスト・設定・通知状態の変更なし。

## 追加観測 toast-v1-007（2026-11-06 JST）

環境WSL2、対象版8e8c442ac81e8f7a5cafc510f1853fa227d56ca1、取得2026-11-05T15:18:38.564604+00:00。autopilot-toast.ps1:12のCreateToastNotifierが指定するMicrosoft.Windows.Shell.RunDialogを完全一致条件に、既存Windows通知DBをmode=ro/query_onlyで集計した。該当ハンドラーは0件、2026-11-05 UTC（ArrivalTimeをFILETIMEと解釈）の結合通知も0件。本文・宛先・Tag・Groupは抽出していない。証拠は.loop/toast-v1-007-diagnostic.json。

このアプリIDは共有され得るうえ、現行notify-owner.mjs:72以降のNotifyIcon経路とは異なる。保持中DBで該当ハンドラーが見つからないことだけを示し、対象done/overdueの不達・通知無効・表示失敗とは断定できない。このDBの同ID照合では対象イベントを相関できず、次はWindows側の既存表示証拠と実稼働タスク定義・版・ユーザーの取得が必要。日次要約と最終報告も未相関。

C1〜C3は未確認、C4は過去全体ゲート終了130のまま未達。今回は新しい限定照合を行い、通知送信・製品変更・同じ失敗操作の再送・ゲート再実行なし。Git実体は引き続き読取り専用。今回のユーザー明示指示に従い文書のみ指定形式でコミットを試みるが、書込み境界は迂回しない。累積7・残1。

## 追加観測 toast-v1-008（2026-11-06 JST）

環境WSL2、対象版8e8c442ac81e8f7a5cafc510f1853fa227d56ca1、取得2026-11-05T15:21:01.209441+00:00。静的読取りでauto-progress-watch.mjs:719–729のreportOverdueがdm/session-inbox/toast/inbox/deferredを成功としてoverdueReportedAtを保存することを確認。notify-owner.mjs:162–170ではdeferredをtoast処理より前に返す。したがってoverdueReportedAt単独はWindows表示の証拠にならず、保留中でも記録され得る。実機適用や製品不具合は確定しない。証拠は.loop/toast-v1-008-diagnostic.json。

C1実稼働版、C2完了・期限超過のWindows表示、C3実機抑止条件、C4全体ゲート完走は未確認。既知inbox受領と分離する。今回通知送信・製品変更・全体ゲート再送なし。累積8・残0で上限到達。新規検証は終了し、Windows側既存表示証拠・タスク版の相関とゲート完走を残件として保存する。Git実体の読取り専用=True。
