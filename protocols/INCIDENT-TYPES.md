# 事故型カタログ（INCIDENT TYPES）

事故・手戻り・user に発見された不具合は、その場の修正に加えて「型」で直す（ONBOARDING §1.22）。
着手時にこの表を検索し、同じ型があれば再利用する（原因調査と横展開の検索式を使い回せるのでコストが下がる）。

## 手順（事故のたびに5点セット）
1. **型で言語化**: 「何が起きたか」でなく「どの構造が壊れやすいか」を1語で（例: 配布漏れ型）。表に既存の型があればそれを使い、無ければ新設する。
2. **横展開**: 同じ型の既存箇所をリポジトリ横断で検索し、見つかった分を同じ PR で直す。検索式は表の「横展開の検索」列に残す。
3. **機械ゲート**: テスト＞hook／lint／converge チェック＞人の確認、の安い順に選び、再発を機械で止める。文書だけの対策は不可（§1.21 の昇格階層で 5 以上を選ぶ）。
4. **全PC配布が要るなら converge へ**: 設定・拡張・スケジュールは `setup --converge`、ルールは onboarding-sync（§1.22 B）。
5. **1行追記**: 下の表へ型・症状・横展開の検索・ゲートを1行足す。同型の再発は `count` を足して昇格を検討する（§1.21 / LEARNING-LEDGER）。

完了報告には「型 / 横展開した箇所数 / 追加したゲート」を書く。ゲートを足せなかったときは理由と次アクションを書く。

## カタログ
| 型 | 症状（初出） | 横展開の検索 | ゲート |
|---|---|---|---|
| 配布漏れ型 | per-PC 機能が1台でだけ動き、converge に未登録。配布対象が手書き一覧で、新しいフォルダ（packages/）が漏れた（2026-10-11 スマホ用待機タブ） | 配布・コピー対象を手書きで列挙している箇所（onboarding-sync のフォルダ一覧、zip 経路、converge の登録表）。per-PC の機能を足す PR | 配布カバレッジのテスト、fleet-scope 宣言レジストリ（fleet か kim-only かの宣言必須）、converge ビーコンと fleet-status |
| 見張りの沈黙故障型 | 自動進行の check（`node C:\Users\...`）が Git bash で `\` を失い MODULE_NOT_FOUND、node の exit 1 が「未達」と同じなので check_error にならず空振り。kim が「進捗どう？」と再度聞いた（2026-11-06）。同時期に Bot DM の依頼は返事待ちの追跡対象外だった（2026-10-26〜11-05） | 終了コードだけで成否を読む見張り（auto-progress check・health check・watchdog）。人への依頼を送る経路で返事待ち台帳に載らないもの | executeCheck のパス正規化＋クラッシュを check_error にして通知、登録時 preflight で拒否、`auto-progress.mjs --audit-checks`（#1622）。Discord 依頼の自動登録 hook と2日超のセッション注入（#1573） |
| 無人再開の古い送信約束実行型 | 無人の auto-progress が、既に人が実行済みの古い `nextClaude` を再開して社外 LINE を承認なしで再送した（2026-11-09） | ヘッドレス resume / start-when と社外送信 CLI。送信文面と現在の承認を結び付けない約束 | PreToolUse で本文 SHA-256 承認マーカーを必須化し、auto-progress 登録時にも送信約束を拒否 |
| 経路取り違え型 | 全PCの設定変更を fleet-mail（相談用・受信側は実行しない設計）で依頼し、未配達・未実行のまま。組織指示「settings.json の変更は converge 経由」に反した（2026-10-11） | 「全PC」「他のPC」への変更依頼を fleet-mail／directive／手渡しで出している箇所と手順書 | fleet-mail 送信前の警告（変更依頼を検知）、受信側の「converge 化が必要」返信（§1.22 C） |
| 観測不能型 | 他PCの状態を照会する手段がなく、未反映を user がスマホで発見した（2026-10-11） | 「全PCに反映した」と報告する箇所。状態を人に確認させている手順 | converge ビーコン、`tools/fleet-status.mjs`（未ビーコンの PC は「未確認」と書く） |
| ログ不在＝不在型 | Claude 側ログに無いことを外部の状態の不在の証拠にした（2026-09-10）。ゲート: external-state-claim-gate | 外部状態を「無い」「未接続」と断定する文面 | external-state-claim-gate（既存） |
| 単一指標の最適化による盲点型 | 費用だけで新AIを選び高性能モデルの品質改善を見逃した（2026-10-15） | selectCandidates / pendingCandidates / evaluationCost / nightly-batch | フロンティア検出・品質+5pt・単価不明・日次評価の回帰テスト。docs/incidents/2026-10-15-frontier-model-blind-spot.md |
| 実行元ツリー固着型 | 定期タスクが同期されない worktree/別クローン/固定ブランチを実行し続け、移行済みの経路(DeepSeek→OpenRouter)を旧コードが本家直結で叩き HTTP 402。実プローブは全レーン正常で監視に映らなかった。同期側も未コミット1ファイル(rescue 済み)で 4日間 skip(2026-10-29 kim-PC・PR #1302) | Orgiast* タスクの Action に nightly-repo 以外のパス(worktree・auto-session-repo・orgiast-main 等)を持つもの。register-*.ps1 で作業ツリーのパスを焼き込む箇所。DIRTY_WORKTREE_SKIP が続く同期ログ | repair-task-paths の worktree/別クローン検出と日次自動実行(ブランチ fix/stale-task-tree-detect)、register-messenger-watch.ps1 -UpdateActionOnly |
| セッション中間状態依存型 | 完了判定がセッション限定の中間状態に依存 → セッション停止で完了を検知できず kim が進捗を聞く羽目に（2026-11-06） | 完了判定スクリプトの scratchpad・nightly-repo/.scratch・/tmp 参照 | auto-progress --add-check の preflight で scratchpad・.scratch・/tmp 参照を拒否（2026-11-06） |
| 配布元URL破損型 | 配布元リポジトリの接続先 URL が壊れ、そのPCだけ main の修正が無言で届かなくなる。fetch は定期処理が古い origin/main へ reset し続けエラーは表に出ない（2026-11-05 PC004） | 各PC の fetch を origin 依存で黙って止める配布経路（bootstrap・fleet-fix-now・.git/config の remote.origin.url を焼く箇所） | access-doctor の origin 自動修復（履歴一致確認後に向け替え・保存ログ）＋ setup-manifest の git-origin check（repo:rules-origin・converge 配布） |
| 過剰ブロック型 | ゲートが To/Cc を区別せず、正当な社外メールの社内 Cc を止めた（2026-11-09 C0055） | `internal_recipient` / `isInternal` / To・Cc・Bcc を一括判定する Gmail 書き込みガード | To に外部がある場合だけ社内 Cc/Bcc を許可し、外部To＋内部Cc/Bcc・内部To＋外部Cc・混在To・内部のみの回帰テスト |
| 無音停止見落とし型 | ツール実行中にセッションが終了したケース（プロセスkill・PC再起動など）を自動進行の巡回が検知できず、kimが「進捗どう？」と聞く羽目になった（2026-11-06〜11-09 11回目）。APIエラー経由だけが検出対象だった | `findUnansweredRequest` の呼出元で silent-stop 非対応の箇所（auto-progress-watch.mjs 以外からの呼出） | transcript末尾の未完了tool_use/mtime45分以上を silent-stop として検出（PR #1802）。watchのregisterUnansweredで通知・再開 |
| 送信前履歴未読型 | 送信前に相手との履歴を読まず、回答済みの質問を再送し、相手の未回答要望を放置した（2026-11-10 C0039） | Gmail・LINE・Discord・Beeper の送信CLIと直接API送信経路。自社送信が受信履歴に残らない経路 | `send-context-check.mjs` の本文ハッシュ＋30分＋最新メッセージID/時刻マーカーを各送信CLIが直前に再検証 |
| 外部チャネル未監視型 | セッションが「返信が届いたら」と宣言した外部チャネル（LINEグループ等）を自動照会する仕組みがなく、resumeSession の連続 timeout で沈黙。kim が「進捗どう？」と聞く羽目に（2026-11-12 e50bea8a LINE エイト様グループ）。Gmail は external-waiting.mjs がカバー済みだが LINE/Discord/Beeper は未対応。再開失敗も kim-inbox に通知されず握りつぶされていた | 「返信待ち」「返事待ち」「返信が届いたら」の promise を持つ auto-progress 行。Supabase channel_messages を読みに行く check が未登録のセッション。resumeOutcome が error/timeout で failureCount>=3 の行 | `auto-progress-external-check.mjs`（新設: LINE Supabase 新着照会 check ツール）。watch の resume-failed 通知（連続3回失敗で kim-inbox🔴）。`auto-progress.mjs --add-check` 登録時に外部チャネル ID を埋め込む標準手順 |
| 再開レーン誤配送型 | セッション再開（auto-progress-watch / stalled-session-resume が runChild に resumeSessionId を渡す）が、既定の実行者 cheap-code に流れて --resume が捨てられ、元の会話に何も届かず「blocked: 成果記録なし」のまま放置された（2026-11-09 セッション 834dfc9c） | runChild の resumeSessionId 分岐（auto-progress-watch.mjs、stalled-session-resume.mjs）。--resume を無視する実行レーン | runChild は resumeSessionId 指定時に claude レーンへ固定（PR #1879、2026-11-11 マージ）。結果 JSON 欠落は error 扱いで再試行。auto-session.test.mjs / auto-progress-watch.test.mjs のテスト |

追記ルール: 型名は構造を表す語にする。症状は1行、日付と出典を付ける。ゲート列が空の行は未完了として扱い、埋まるまで消さない。

- 型: 秘匿置換による通知識別子衝突型（2026-11-13 エイト様 LINE 新着640415182069432706、watch summary 06:00:00Z・外部イベント台帳）→ dedupeKey のハッシュが一律 [REDACTED] となり回答済み別通知へ誤集約。対策: 置換・切詰め対象キーは安定した分割ダイジェストで保持し、誤った既存受領記録を本文照合で修復して未通知分だけ再キュー。ゲート: tools/auto-progress-external-monitor.test.mjs（実 inbox・復旧再実行）/ tools/kim-inbox.test.mjs（秘匿キー・spool 重複防止）。

- 型: ループ誤判定型（再接続の空振りを無限ループと誤判定し、正当な再接続まで遮断）: reopenLoop ガードが「24時間・試行回数」で数え、切断中のままのセッションを3回の空振りで24h遮断した（2026-11-09 実測・4本） → 対策: 成功（verified）した再接続だけを60分窓で数え、unverified は数えない。一覧取得失敗は nightly-reload-vscode が3回リトライして ERROR を残す（無言 SKIP しない）。ゲート: reopen-lost-sessions.test.mjs / nightly-reload-vscode.test.ps1
- 型: 夜間メンテが待機中セッションを「作業中でない」と誤判定して殺す（活動時刻ベースの busy 判定） → 対策: 生存＋未クローズで保護、落ちたら host_exit から自動再オープン。
- 型: 秘密入りの成果物を「既定の置き場」に出し、置き場の継承共有で広く見える（既定フォルダ＝社内全体・外部Gmail継承） → 対策: 本文の秘密検出で共有フォルダへの出力を拒否し --private（owner のみを読み戻し）を必須化。ゲート: gdoc-publish.mjs containsSecret（exit 3/4）。2026-11-07 PR #1682
- 型: 完了フラグの台帳が再開・新しい状態表明で失効しない → セッションが【閉じて可】のまま期限再開・朝確認から外れる（2026-11-09 4eb1d8a6）／対策: 最新フッター優先＋プロンプト受信・未完フッターで closed-sessions.json から自動除外（session-wait-title・closed-sessions-ledger）
- 型: rescue/cherry-pick が全廃済みの経路を復活させる（2026-11-10 kim 宛 Discord DM 復活・PR #1688） → 横展開の検索: git log --all --oneline --grep="kim-discord-allowlist\|KIM_DISCORD_USER_ID" で該当箇所を特定し、kim 宛 Discord/webhook 送信経路を全て削除。ゲート: tools/kim-discord-dm-ban.test.mjs（静的走査 + discordAllowed 常時 false 確認）
- 型: 人待ちの沈黙停止型（セッション内 cron の1行報告だけが続き、user は別セッションで気付かず社外クレーム、2026-11-09 就労証明書の LINE 画像認証待ち6日） → 横展開の検索: 人待ち（ログイン待ち・画像認証・返事待ち）を報告して止まる Stop 文面と、待つ経路の成立を検証しない箇所 → ゲート: urgent-blocker 登録（Stop gate が未登録の人待ち報告を block）+ 別セッション割り込み表示（UserPromptSubmit/SessionStart hook）+ 経路検証・代替経路・自動再試行の指示（tools/urgent-blocker-wait-gate.mjs）
- 型: ゲート間相互ブロック型（gmail-connector-url-gate が URL を理由に block → mail-send-approval-gate が body 無しの draftId 送信を CONTEXT_REASON で block → 両方満たす送信経路が消える。2026-11-12 014 実測） → 横展開の検索: tool_input.draftId 有無で分岐するゲート、複数ゲートが同一の tool_input を異なる基準で判定する箇所 → ゲート: gmail-connector-url-gate の draftId 送信 pass 判定（既存）
- 型: 人の属性（kim 操作席）で資格情報が要るジョブの配置を決めた → 判定は資格情報の実在で行う（2026-11-12 deadline-seat DWD鍵） → 横展開の検索: isKimOperated だけで資格情報不要と判断している定期ジョブ登録 → ゲート: `--seat-check` に dwdKey 実在を追加、tasks.ps1は kim=false で既存タスクを無効化


- 型: 無人ジョブが UAC 必須インストールを起動し確認画面を溜める（2026-11-09〜11 作業用014: ClaudeDailyDriveBackup が毎晩 winget install Google.GoogleDrive を非昇格のまま起動し、誰も押さない UAC が consent.exe として残り続けた。2026-11-12 には cheap-code-worker の headless LLM セッションが同様に winget install を起動） → 横展開の検索: tools 配下の定期ジョブ・hook・無人ジョブ（LLM セッション経由を含む）からの `winget install` / `-Verb RunAs` / msiexec 起動箇所（backup-claude-to-drive.ps1 / register-claude-backup-task.ps1 / setup-node-runtime-security.mjs を修正、bootstrap・install-orgiast・restore・fleet-fix-now は対話専用として一覧維持。PreToolUse gate: unattended-elevation-gate が headless LLM セッションからの直接起動を遮断） → ゲート: tools/uac-unattended-install.test.mjs（非昇格の無人実行では起動しない。対話専用は明示一覧。タイムアウト時はプロセスツリー kill）+ tools/unattended-elevation-gate.mjs（PreToolUse hook が LLM セッションの Bash/PowerShell から UAC 必須コマンドを遮断）
