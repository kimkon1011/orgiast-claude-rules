# 対象: protocols/INCIDENT-TYPES.md
# 調査日: 2026-11-17

## 調査方法

- `protocols/INCIDENT-TYPES.md` の全事故型を列挙し、`tools/hook-dispatch-manifest.json` に登録された機械ゲート（hook）が対応しているかを突き合わせた。
- `.claude/hooks/` 配下は空。`.claude/settings.json` の hooks は全て `hook-dispatch.mjs` 経由で manifest を参照する構造（グローバル `~/.claude/settings.json` で受けて dispatch）。
- manifest に無い場合でも `tools/stop-gate-runner.mjs` が import する gate は「stop-gate-runner 経由で稼働」と判定した。
- テストファイルのみのゲート（`*.test.mjs`）や CLI ツール（定期ジョブ・コマンドライン実行）は hook ゲートとは見なさず「なし」と判定した。

## 全事故型の一覧（ゲート有無つき）

| # | 事故型 | 対応 hook 名（manifest 内） | 判定根拠 |
|---|---|---|---|
| 1 | 配布漏れ型 | SessionStart: converge/fleet-convergence-sync/tool-adoption-check/onboarding-sync | converge 系 SessionStart 非同期 hook でカバー。PreToolUse/Stop の実時間ゲートは無いが定期配布で対応 |
| 2 | 見張りの沈黙故障型 | **なし** | ゲート列に `executeCheck` パス正規化・`auto-progress.mjs --audit-checks` とあるが、いずれも auto-progress 本体のコード変更であり manifest に hook 登録無し。テストファイルも無し |
| 3 | 無人再開の古い送信約束実行型 | PreToolUse: mail-send-approval-gate | `mail-send-approval-gate` が PreToolUse に登録済み。ただし「auto-progress 登録時にも送信約束を拒否」の部分は hook ではなく auto-progress 側の preflight |
| 4 | 誤止め放置→user手渡し型 | Stop: user-burden-gate（stop-gate-runner 経由） | `user-burden-gate.mjs` が stop-gate-runner に import 済みで稼働 ✅ |
| 5 | 経路取り違え型 | **なし（部分）** | ゲート列に `fleet-mail 送信前の警告` とあるが manifest に fleet-mail 警告 hook は無し。`register-fleet-mail.mjs` はツールとして存在するが hook 未登録。受信側 converge 返信は SessionStart 側でカバー |
| 6 | 観測不能型 | SessionStart: converge/fleet 系 | 定期配布と fleet-status CLI でカバー。実時間 hook ではない |
| 7 | ログ不在＝不在型 | Stop: external-state-claim-gate（stop-gate-runner 経由） | `external-state-claim-gate.mjs` が stop-gate-runner に import 済み ✅ |
| 8 | 単一指標の最適化による盲点型 | **なし** | ゲート列に「フロンティア検出・回帰テスト」とある。テスト・ドキュメントのみで hook 無し |
| 9 | 実行元ツリー固着型 | **なし** | ゲート列に `repair-task-paths` `register-messenger-watch.ps1 -UpdateActionOnly`。いずれも CLI/定期ツール。manifest に hook 登録無し |
| 10 | セッション中間状態依存型 | SessionStart/UserPromptSubmit: session-purpose-gate | `session-purpose-gate.mjs` が SessionStart と UserPromptSubmit に登録済み ✅ |
| 11 | 配布元URL破損型 | **なし** | ゲート列に `access-doctor` `setup-manifest git-origin check`。いずれも CLI ツール。hook 登録無し |
| 12 | 過剰ブロック型 | PreToolUse: internal-recipient-gmail-guard | `internal-recipient-gmail-guard.mjs` が PreToolUse に登録 ✅ |
| 13 | 無音停止見落とし型 | Stop: auto-progress-ledger（manifest + stop-gate-runner）、stop-gate-runner | silent-stop 検出は auto-progress-ledger 経由でカバー。ただし「mtime45分以上」の検出が manifest 上の別 hook として登録されているかは不明瞭。stop-gate-runner でまとめて処理 |
| 14 | 送信前履歴未読型 | PreToolUse: mail-consistency-gate、stop-gate-runner: send-context-check （stop-gate-runner 経由で未確認） | `mail-consistency-gate` は PreToolUse 登録済み。`send-context-check.mjs` は tools に存在するが manifest 独自 hook としては未登録。ただし stop-gate-runner 内の `state-claim-evidence` が一部カバー |
| 15 | ツール不在の弱検証渡し型 | PreToolUse: pdf-deliverable-visual-gate | `pdf-deliverable-visual-gate` が PreToolUse に登録済み ✅ |
| 16 | 外部チャネル未監視型 | **なし** | `auto-progress-external-check.mjs` は tools に存在するが **manifest に未登録**。ゲート列に「新設」と明記された未完了型 |
| 17 | 再開レーン誤配送型 | PreToolUse: pretooluse-lane-guard | `pretooluse-lane-guard.mjs` が PreToolUse 登録済み ✅（PR #1879） |
| 18 | 秘匿置換による通知識別子衝突型 | **なし（テストのみ）** | ゲート列にテストファイル名 (`auto-progress-external-monitor.test.mjs` `kim-inbox.test.mjs`) のみ。hook 登録無し |
| 19 | ループ誤判定型 | **なし（テストのみ）** | ゲート列にテストファイル名 (`reopen-lost-sessions.test.mjs` `nightly-reload-vscode.test.ps1`) のみ。hook 登録無し |
| 20 | 夜間メンテが待機中セッション誤判定 | **なし** | ゲート列に具体的な hook 名の記載無し。対策文章に「生存＋未クローズで保護、落ちたら host_exit から自動再オープン」とあるが、これに対応する manifest hook は無い |
| 21 | 秘密入りの成果物を「既定の置き場」に | **なし** | ゲート列に `gdoc-publish.mjs containsSecret（exit 3/4）`。gdoc-publish はツールであり hook ではない。PreToolUse ゲートとしての登録無し |
| 22 | 完了フラグの台帳が再開で失効しない | Stop/SessionStart: session-wait-title | `session-wait-title` が Stop と SessionStart に登録済み ✅ |
| 23 | rescue/cherry-pick が全廃済み経路を復活 | **なし（テストのみ）** | ゲート列に `tools/kim-discord-dm-ban.test.mjs` とあるがテストのみ。PreToolUse ゲート無し |
| 24 | 人待ちの沈黙停止型 | Stop: urgent-blocker-wait-gate（stop-gate-runner 経由） + SessionStart/UserPromptSubmit: urgent-blocker --context | `urgent-blocker-wait-gate` が stop-gate-runner に import 済み ✅。`urgent-blocker.mjs --context` も SessionStart と UserPromptSubmit に登録済み |
| 25 | ゲート間相互ブロック型 | PreToolUse: gmail-connector-url-gate | `gmail-connector-url-gate` が PreToolUse 登録済み ✅（draftId 送信 pass 判定で修正済み） |
| 26 | 人の属性で資格情報が要るジョブ配置 | **なし** | ゲート列に `--seat-check` `tasks.ps1` とある。いずれも CLI フラグ/定期ツール。hook 登録無し |
| 27 | 無人ジョブがUAC必須インストールを起動 | PreToolUse: unattended-elevation-gate | `unattended-elevation-gate` が PreToolUse 登録済み ✅ |
| 28 | 安いAIレーン停止時に代替へ回らず肩代わり | PreToolUse: pretooluse-lane-guard、delegation-ratio-watch（定期） | PreToolUse ゲートは存在する。delegation-ratio-watch は定期ツールで hook ではないが、lane-guard がリアルタイムにカバー |
| 29 | Stopゲート書換えループ型 | Stop: inbox-section-filter（stop-gate-runner 経由） | `inbox-section-filter.mjs` が stop-gate-runner の `stripInboxSection` として import 済み ✅。block 上限も stop-gate-runner 内で処理 |
| 30 | 調査の外注先が user→社員移行で素通り | PreToolUse: staff-ask-selfcheck-gate + Stop: pending-decision-ask-gate（stop-gate-runner 経由） | 両方とも登録済み ✅ |

## ゲート未整備・優先3件

### 優先1: 見張りの沈黙故障型

**症状**: auto-progress の check が Windows パス正規化の不備（Git Bash で `\` が消失 → MODULE_NOT_FOUND）で exit 1 になるが、exit コードが「未達」と同じ値のため check_error にならず空振り。見張りが沈黙故障し、kim が「進捗どう？」と再問い合わせする。
初出: 2026-11-06。同時期に Bot DM の返事待ち追跡も未対応（2026-10-26〜11-05）。

#### 検出すべき条件

- **応答文面**: 「check_error」「executeCheck」「auto-progress」「check が失敗」などの語句を含みつつ、問題を「解消済み」「修正した」などと報告している。本来 check_error として検出されるべき事象が、正常系の報告として処理されている。
- **正規表現条件**: 以下の両方を満たす応答を検出対象とする:
  ```
  /auto-progress|executeCheck|check.*(?:失敗|error|not found)/i
  ```
  かつ
  ```
  /exit.?code|exit.?1|MODULE_NOT_FOUND|path.*normalize/i
  ```
  かつ応答が block/warn を経由せず完了報告している。
- **Stop 時の条件**: 応答が「check 完了」「全 check PASS」などと主張しているにもかかわらず、直近の check 実行ログに exit 1 または `MODULE_NOT_FOUND` が含まれている。

#### hook イベント種別

**Stop**（応答完成後、最終チェックとして）。
理由: 応答の全文を分析して、check の成功主張と実際の exit コードの矛盾を検出する必要がある。PreToolUse では check の実行結果が出揃っていない。

#### block か warn か

**warn（警告のみ）**。理由: 誤検知リスクが高い（check の exit 1 が真性の失敗である場合と誤検出である場合の区別が難しい）。warn で additionalContext として注入し、Claude 側に自己修正させる。一定回数以上（例: 同一セッション3回）連続で warn を無視した場合のみ block に昇格。

#### 誤検知を避けるための除外条件

- 応答が「check_error を検出した」「exit 1 を確認した」と明示的に failures を報告している場合は除外（本来の検出経路が正常に機能している証拠）
- コードブロック内の引用（他セッションのログ・エラーメッセージの引用）は除外
- check 実行が明示的に「dry-run」「--dry-run」フラグ付きの場合は除外
- ファイル編集（Write/Edit）の応答は除外（auto-progress check の実行ではない）
- テストファイル (`*.test.mjs`) の出力は除外

---

### 優先2: 実行元ツリー固着型

**症状**: 定期タスクが同期されない worktree/別クローン/固定ブランチを実行し続け、移行済みの経路（DeepSeek→OpenRouter）を旧コードが本家直結で叩き HTTP 402。実プローブは全レーン正常で監視に映らず、同期側も未コミットファイルで4日間 skip。kim-PC・PR #1302（2026-10-29）。
初出: 2026-10-29。横展開として Orgiast* タスクの Action に nightly-repo 以外のパスを持つものを検索。

#### 検出すべき条件

- **実行前（PreToolUse）**: Bash/PowerShell で `node tools/xxx.mjs` や `node ～/auto-progress.mjs` などの定期ジョブ起動時に、cwd またはスクリプトのパスが `nightly-repo` 以外の worktree/別クローンである。特に以下のパターン:
  ```
  C:\\Users\\kimko\\.claude\\wt-
  C:\\Users\\kimko\\orgiast-main
  C:\\Users\\kimko\\Downloads\\orgiast-claude-rules
  auto-session-repo
  ```
  で始まるパスで、かつ最新の remote と同期していない可能性があるもの。
- **応答文面（Stop）**: 「タスク実行完了」「定期ジョブ実行」と報告しているが、実行パスが `nightly-repo` 以外の worktree。かつ実行内容が「旧経路（DeepSeek 直結など）」を使用している兆候がある。
- **補助条件**: `git -C <path> rev-parse --show-toplevel` の結果が `nightly-repo` と異なり、かつ `git -C <path> remote -v` が origin を指していることを確認する（同一リポジトリの worktree か否かを判定）。

#### hook イベント種別

**PreToolUse**（実行前に検出）。
理由: 古いツリーでのジョブ実行を実行前に検出し、block してからユーザーに確認を取る方が、実行後の結果整合性より安い。定期ジョブの場合は「意図的（レガシー互換）」もありうるので block ではなく ask が適切。

#### block か warn か

**block（差し戻し）+ ask（permissionDecision: ask）**。
理由: 古いツリーでジョブを実行すると HTTP 402 やサイレントスキップなど検知困難な副作用が発生する（4日間の実績あり）。ask で「このパスで実行します（最新ツリーではありません）。続行しますか？」と確認を取る。確認を得た後は同一セッション内での同種実行は自動許可（過剰ブロック回避）。

#### 誤検知を避けるための除外条件

- パスが `nightly-repo` またはその直接の worktree である場合（`git worktree list` で確認）
- 読み取り専用のコマンド（`git status` `git log` `Read` `Grep` `Glob`）— 副作用無し
- `git worktree add/remove` など worktree 自体を管理する操作
- `.claude/` 配下の設定ファイル操作
- `task/` ディレクトリ配下の操作（定期ジョブの指示ファイル置き場で、実行自体が目的ではない）
- `--dry-run` フラグ付きのジョブ
- `nightly-repo` を origin として持ち、最新に追従済みであることが `git fetch --dry-run` 等で確認できた場合

---

### 優先3: 外部チャネル未監視型

**症状**: セッションが「返信が届いたら」と宣言した外部チャネル（LINEグループ等）を自動照会する仕組みが無く、resumeSession の連続 timeout で沈黙。kim が「進捗どう？」と聞く羽目に。
初出: 2026-11-12（e50bea8a LINE エイト様グループ）。Gmail は external-waiting.mjs がカバー済みだが LINE/Discord/Beeper は未対応。
ゲート列に「auto-progress-external-check.mjs（新設）」と明記されており、**未完了** の事故型。

`tools/auto-progress-external-check.mjs` および `tools/auto-progress-external-monitor.mjs` はファイルとして存在するが、**hook-dispatch-manifest.json に未登録**。

#### 検出すべき条件

- **Stop 時の応答文面**: 以下の語句を含む promise/約束を発行している:
  ```
  /返信(待|が届い|があっ|を待)|返事待|回答待|reply.*wait|awaiting.*reply/i
  ```
  かつ、その約束対象が Gmail 以外のチャネル（LINE / Discord / Beeper）を指している。
- **UserPromptSubmit 時の宣言**: ユーザーのプロンプトに「返信待ち」「回答待ち」など外部チャネルの返事を待つ表明がある場合。
- **PreToolUse**: `auto-progress.mjs --add-check` が呼ばれた際、check の種類が Gmail 以外の外部チャネル（LINE Supabase の `channel_messages` 等）を参照していない場合、登録時に警告する。

#### hook イベント種別

**Stop**（約束の検出 + 登録督促）および **UserPromptSubmit**（context 注入）。
理由: Stop で約束を検出し、auto-progress ledger に未登録であれば block して登録を促す。UserPromptSubmit で既存の未監視チャネル情報を additionalContext として注入。

#### block か warn か

**block（差し戻し）**。
理由: 外部チャネルの返信待ちを宣言して監視を仕掛けないと、kim が「進捗どう？」と再問い合わせするまで無人の SLA が空費される。実害あり（2026-11-12 LINE エイト様グループ）。監視未登録の約束は block して登録を強制する。

#### 誤検知を避けるための除外条件

- Gmail の返信待ち（`external-waiting.mjs` がカバー済み）は除外
- 「返信をしました」「返信を送りました」など過去形・送信側の場合は除外
- コードブロック内の引用（他セッションのログ・会話履歴の引用）は除外
- ユーザーからの直接の指示（「LINE で返事待ってて」など user 発の指示）は除外 — user が明示的にそう指示している場合は監視未登録でも block しない
- auto-progress ledger に既に外部チャネル check が登録済みの場合は除外

---

## 別観点の集計と優先候補（同日の別セッション版から統合）

同じ調査を別セッションが `tools/setup-manifest.json` 側から行った版があり、退避枝 `rescue/auto-session-20261117-170027` に残っていた。重複を避けるため本書に統合する。

- 集計: 37 事故型のうち 24 型に既存の機械ゲートあり、13 型が未整備。
- 別観点（kim の手戻り頻度基準）で選ばれた優先3件:
  1. **誤止め放置→user 手渡し型** — PreToolUse（deny 時）で block。BLOCK-REPAIRED 検査が二重 block にならないよう、読み取り専用エージェントは除外する。
  2. **無人再開の古い送信約束実行型** — SessionStart と PreToolUse で block。本文 SHA-256 の承認マーカーが無い古い `nextClaude` の再開を拒否する。
  3. **無音停止見落とし型** — UserPromptSubmit（auto-progress-watch）で warn。未完了 tool_use ＋ mtime 45 分以上を silent-stop として通知する。
- 実装順は、本書上部の「ゲート未整備・優先3件」（見張りの沈黙故障型／実行元ツリー固着型／外部チャネル未監視型）を先にする。こちらは `hook-dispatch-manifest.json` との実突合に基づく判定で、根拠が強いため。