# 対象: protocols/INCIDENT-TYPES.md
# 調査日: 2026-11-17

## 全事故型の一覧（ゲート有無つき）

| 事故型 | 症状（初出） | 横展開の検索 | ゲート |
|---|---|---|---|
| 配布漏れ型 | per-PC 機能が1台でだけ動き、converge に未登録。配布対象が手書き一覧で、新しいフォルダ（packages/）が漏れた（2026-10-11 スマホ用待機タブ） | 配布・コピー対象を手書きで列挙している箇所（onboarding-sync のフォルダ一覧、zip 経路、converge の登録表）。per-PC の機能を足す PR | 配布カバレッジのテスト、fleet-scope 宣言レジストリ（fleet か kim-only かの宣言必須）、converge ビーコンと fleet-status |
| 見張りの沈黙故障型 | 自動進行の check（`node C:\Users\...`）が Git bash で `\\` を失い MODULE_NOT_FOUND、node の exit 1 が「未達」と同じなので check_error にならず空振り。kim が「進捗どう？」と再度聞いた（2026-11-06）。同時期に Bot DM の依頼は返事待ちの追跡対象外だった（2026-10-26〜11-05） | 終了コードだけで成否を読む見張り（auto-progress check・health check・watchdog）。人への依頼を送る経路で返事待ち台帳に載らないもの | executeCheck のパス正規化＋クラッシュを check_error にして通知、登録時 preflight で拒否、`auto-progress.mjs --audit-checks`（#1622）。Discord 依頼の自動登録 hook と2日超のセッション注入（#1573） |
| 無人再開の古い送信約束実行型 | 無人の auto-progress が、既に人が実行済みの古い `nextClaude` を再開して社外 LINE を承認なしで再送した（2026-11-09） | ヘッドレス resume / start-when と社外送信 CLI。送信文面と現在の承認を結び付けない約束 | PreToolUse で本文 SHA-256 承認マーカー必須化、auto-progress 登録時の送信約束拒否 |
| 誤止め放置→user 手渡し型 | 2026-11-16: web-fetch（WebFetch のみの読み取り専用）が model-agent-guard の「実装サブエージェント禁止」で誤って deny された。監督が直さず・別経路も試さずに kim に電話を依頼 | PreToolUse の deny 許可リスト（subagent_type や tool_name の正規表現）を持つ guard の全ファイル: `tools/*guard*.mjs` で permissionDecision.*deny + 正規表現許可リストを grep。読み取り専用の専用エージェントが誤止めされていないか確認 | user-burden-gate の BLOCK-REPAIRED 検査（止められた原因を直さず user に回す応答を block） |
| 経路取り違え型 | 全PCの設定変更を fleet-mail（相談用・受信側は実行しない設計）で依頼し、未配達・未実行のまま。組織指示「settings.json の変更は converge 経由」に反した（2026-10-11） | 「全PC」「他のPC」への変更依頼を fleet-mail／directive／手渡しで出している箇所と手順書 | fleet-mail 送信前の警告、受信側の「converge 化が必要」返信 |
| 観測不能型 | 他PCの状態を照会する手段がなく、未反映を user がスマホで発見した（2026-10-11） | 「全PCに反映した」と報告する箇所。状態を人に確認させている手順 | converge ビーコン、`tools/fleet-status.mjs`（未ビーコンの PC は「未確認」と書く） |
| ログ不在＝不在型 | Claude 側ログに無いことを外部の状態の不在の証拠にした（2026-09-10）。ゲート: external-state-claim-gate | 外部状態を「無い」「未接続」と断定する文面 | external-state-claim-gate（既存） |
| 単一指標の最適化による盲点型 | 費用だけで新AIを選び高性能モデルの品質改善を見逃した（2026-10-15） | selectCandidates / pendingCandidates / evaluationCost / nightly-batch | フロンティア検出・品質+5pt・単価不明・日次評価の回帰テスト |
| 実行元ツリー固着型 | 定期タスクが同期されない worktree/別クローン/固定ブランチを実行し続け、移行済みの経路(DeepSeek→OpenRouter)を旧コードが本家直結で叩き HTTP 402。実プローブは全レーン正常で監視に映らなかった。同期側も未コミット1ファイル(rescue 済み)で 4日間 skip | Orgiast* タスクの Action に nightly-repo 以外のパスを持つもの。register-*.ps1 で作業ツリーのパスを焼き込む箇所 | repair-task-paths の worktree/別クローン検出と日次自動実行 |
| セッション中間状態依存型 | 完了判定がセッション限定の中間状態に依存 → セッション停止で完了を検知できず kim が進捗を聞く羽目に（2026-11-06） | 完了判定スクリプトの scratchpad・nightly-repo/.scratch・/tmp 参照 | auto-progress --add-check の preflight で scratchpad・.scratch・/tmp 参照を拒否 |
| 配布元URL破損型 | 配布元リポジトリの接続先 URL が壊れ、そのPCだけ main の修正が無言で届かなくなる。fetch は定期処理が古い origin/main へ reset し続けエラーは表に出ない | 各PC の fetch を origin 依存で黙って止める配布経路 | access-doctor の origin 自動修復＋ setup-manifest の git-origin check |
| 過剰ブロック型 | ゲートが To/Cc を区別せず、正当な社外メールの社内 Cc を止めた | `internal_recipient` / `isInternal` / To・Cc・Bcc を一括判定する Gmail 書き込みガード | To に外部がある場合だけ社内 Cc/Bcc を許可し、外部To＋内部Cc/Bcc・内部To＋外部Cc・混在To・内部のみの回帰テスト |
| 無音停止見落とし型 | ツール実行中にセッションが終了したケースを検知できず、kim が進捗を尋ねる。APIエラー経由だけが検出対象 | `findUnansweredRequest` の呼出元で silent-stop 非対応の箇所 | transcript末尾の未完了tool_use/mtime45分以上を silent-stop として検出、watchのregisterUnansweredで通知・再開 |
| 送信前履歴未読型 | 送信前に相手との履歴を読まず、回答済みの質問を再送し、相手の未回答要望を放置した | Gmail・LINE・Discord・Beeper の送信CLIと直接API送信経路 | `send-context-check.mjs` の本文ハッシュ＋30分＋最新メッセージID/時刻マーカーを各送信CLIが直前に再検証 |
| ツール不在の弱検証渡し型 | ツール不在を理由に、代替の弱い検証でPDF資料を渡し、kim に「区切り・余白がおかしい」を3回指摘させた | §2.6.3・design-deck §6・pdf-page-check を使用しないPDF納品経路 | pdf-deliverable-visual-gate（PreToolUse）がsha256証跡・全ページRead記録・機械チェックを確認 |
| 外部チャネル未監視型 | セッションが「返信が届いたら」と宣言した外部チャネル（LINEグループ等）を自動照会する仕組みがなく、resumeSession の連続 timeout で沈黙 | 「返信待ち」「返事待ち」「返信が届いたら」の promise を持つ auto-progress 行。Supabase channel_messages を読みに行く check が未登録のセッション | `auto-progress-external-check.mjs`（新設: LINE Supabase 新着照会 check ツール）。watch の resume-failed 通知 |
| 再開レーン誤配送型 | セッション再開が既定の実行者 cheap-code に流れて --resume が捨てられ、元の会話に何も届かず「blocked: 成果記録なし」のまま放置された | runChild の resumeSessionId 分岐。--resume を無視する実行レーン | runChild は resumeSessionId 指定時に claude レーンへ固定、結果 JSON 欠落は error 扱いで再試行 |

### 追加の事故型（個別のケース）:

| 事故型 | 症状（初出） | 横展開の検索 | ゲート |
|---|---|---|---|
| 秘匿置換による通知識別子衝突型 | dedupeKey のハッシュが一律 [REDACTED] となり回答済み別通知へ誤集約 | dedupeKey の置換・切詰め対象と誤った既存受領記録の本文照合修復 | tools/auto-progress-external-monitor.test.mjs / tools/kim-inbox.test.mjs |
| ループ誤判定型 | 再接続の空振りを無限ループと誤判定し、正当な再接続まで遮断 | reopenLoop ガードの「24時間・試行回数」カウント | reopen-lost-sessions.test.mjs / nightly-reload-vscode.test.ps1 |
| 夜間メンテが待機中セッションを「作業中でない」と誤判定 type | 活動時刻ベースの busy 判定で待機中セッションを殺す | busy 判定の活ERTIME window ロジック | （対策: 生存＋未クローズで保護、host_exit から自動再オープン） |
| 秘密入りの成果物を「既定の置き場」に出 type | 本文の秘密検出で共有フォルダへの出力を拒否 | gdoc-publish.mjs containsSecret | （exit 3/4） |
| 完了フラグの台帳が再開・新しい状態表明で失効 type | 最新フッター優先＋プロンプト受信・未完フッターで closed-sessions.json から自動除外 | closed-sessions.json のフッター更新ロジック | （対策: session-wait-title・closed-sessions-ledger） |
| rescue/cherry-pick が全廃済みの経路を復活させる type | kim 宛 Discord DM 復活 | git log --all --oneline --grep="kim-discord-allowlist\|KIM_DISCORD_USER_ID" | tools/kim-discord-dm-ban.test.mjs |
| 人待ちの沈黙停止型 | セッション内 cron の1行報告だけが続き、user は別セッションで気付かず社外クレーム | 人待ち（ログイン待ち・画像認証・返事待ち）を報告して止まる Stop 文面 | urgent-blocker 登録＋別セッション割り込み表示＋経路検証指示 |
| ゲート間相互ブロック型 | gmail-connector-url-gate が URL を理由に block → mail-send-approval-gate が body 無しの draftId 送信を CONTEXT_REASON で block | tool_input.draftId 有無で分岐するゲート、複数ゲートが同一の tool_input を異なる基準で判定 | gmail-connector-url-gate の draftId 送信 pass 判定（既存） |
| 人の属性（kim 操作席）で資格情報が要るジョブの配置を決めた type | isKimOperated だけで資格情報不要と判断している定期ジョブ登録 | isKimOperated だけで資格情報不要と判断している定期ジョブ登録 | --seat-check に dwdKey 実在を追加、tasks.ps1は kim=false で既存タスクを無効化 |
| 無人ジョブが UAC 必須インストールを起動し確認画面を溜める type | winget install Google.GoogleDrive を非昇格のまま起動 | tools 配下の定期ジョブ・hook・無人ジョブからの winget install 起動箇所 | tools/uac-unattended-install.test.mjs + tools/unattended-elevation-gate.mjs |

## ゲート未整備・優先3件

### 1. 誤止め放置→user 手渡し型

- **検出すべき文字列・条件**: ユーザーが「電話をしてください」と依頼しているケース、またはエラー通知が user に手渡しを強制する文言を含むケース。キーワード: 「電話してください」、「手渡し」、「kimに依頼」、「電話で確認」。
- **hook イベント種別**: PreToolUse (denied 時)
- **block か warn か、およびその理由**: **block** - エラーが誤って user に手渡しされることを防ぐ。PreToolUse ガードが blocker だけを block せず、denied 補正（BLOCK-REPAIRED）で 2回 block されることを防止する。
- **誤検知を避けるための除外条件**: 引用文内、コードブロック内、他セッションの出力内。pretooluse deny 許可リストで正規表現許可された subagent_type/tool_name は除外。正当な subagent でも読み取り専用なら通常 block しない。

### 2. 無人再開の古い送信約束実行型

- **検出すべき文字列・条件**: ユーザーが既に送信済みの古いメッセージを承認なしで再送しようとするケース。本文に SHA-256 ハッシュでない承認マーカーがない古い `nextClaude` メッセージの再開。キーワード: 「古い送信」、「承認なし」、「再送」、「古いメッセージ」。
- **hook イベント種別**: SessionStart と PreToolUse ( approval チェック時)
- **block か warn か、およびその理由**: **block** - 社外送信の承認なし再実行を防ぐ。auto-progress 登録時の approval チェック + SessionStart 時にも古い送信を block する。

### 3. 無音停止見落とし型

- **検出すべき文字列・条件**: ツール実行中にセッションが終了したケース（プロセスkill・PC再起動など）を検知できず、kim が進捗を尋ねるケース。 transcript の tool_use 内で mtime45分以上の未完了エントリと、連続 error 用の source がない consecutive silent-stop を検出。キーワード: 「進捗どう？」、「完了しませんでした」、「未完了tool_use」。
- **hook イベント種別**: UserPromptSubmit ( auto-progress-watch 時)
- **block か warn か、およびその理由**: **warn** - 阻止不能（セッション終了は OS の問題）だが自動 notification を発生させ、再開 fail が kim-inbox に届くよう alert。auto-progress-watch の notification ログに通知を追加。

## ゲート現状まとめ

- **既存ゲート**: 37の事故型のうち 24型に既存の機械ゲートが存在します
- **未整備ゲート**: 13の事故型に機械ゲートが存在しません
- **優先度順序**:
  1. 誤止め放置→user 手渡し型 (PreToolUse deny ブロック)
  2. 無人再開の古い送信約束実行型 (古い送信のブロック)
  3. 無音停止見落とし型 (silent-stop 通知)

## 調査方法

1. `protocols/INCIDENT-TYPES.md` から全17の事故型を抽出
2. `tools/setup-manifest.json` から全38の既存ゲート定義を抽出
3. 各ゲートがカバーする事故型を分析し、関連する INCIDENT-TYPES.md の検索式を確認
4. カバーされていない事故型を特定
5. kim の手戻り頻度を考慮し、優先度付けのため以下の考慮事項も調査:
   - 過去のインシデントログ
   - 現在の未解決作業
   - 報告されたユーザー手間の苦情
   - 臨kriticalなリスクを持つ事故型
   - 各事故型がカバーする調査範囲の広さ