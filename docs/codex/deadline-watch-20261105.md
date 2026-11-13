# 期限台帳（deadline-watch）実装指示（2026-11-05 夜間・Codex）

<!-- lane: codex -->

## 背景（kim 2026-11-03 指示）
ベンツの車検切れ、訴訟資料の提出期限切れ、消防の質問書の回答期限切れが起きた。期限のある義務を kim が思い出して頼むのではなく、メール・Drive・LINE から**自動で見つけ、台帳に載せ、間に合うように追いかけ、kim の作業セッションに割り込んで**届ける仕組みを作る。Discord 通知は本数が多すぎて読まれていない（kim 宛 Discord は全面禁止・PreToolUse ゲートで deny）。既存の kim-inbox も「別のパソコンへ送った連絡が届いていない」系の info が 580 件以上積もり、古い順に 5 件しか表示されないため、新しい期限が永遠に見えない。これも直す。

## 目的
1. **期限台帳**（Google スプレッドシート、kim@orgiast.jp 所有）を正本に、`tools/deadline-detect.mjs`（夜間の自動検出）と `tools/deadline-watch.mjs`（毎朝の追跡・通知）を作る。
2. kim-inbox に **期限レーン**（kind=`deadline`）を足し、セッション注入の**先頭**に必ず出す。
3. kim-inbox の**ノイズを発生源で止める**。

既存の雛形: `tools/vehicle-inspection-watch.mjs`（今日作った車検版。段階通知・台帳更新・kim-inbox 連携の作法はこれに合わせる）、`tools/invoice-payment-chase`（skills 側の追跡台帳）、`tools/kim-inbox.mjs`、`tools/gmail-search.mjs`（DWD、`--user` で kim@/seisaku-team@）、`tools/lib/sheets-dwd.mjs`、`tools/lib/drive-auth.mjs`、`tools/line-history-sync.mjs`（LINE は Sheets に同期済み）、`tools/discord-inbox-intake.mjs`、`tools/llm-ask.mjs`（`--provider gemini` が既定の安い経路）、`tools/register-vehicle-inspection-task.ps1`、`tools/auto-progress-digest.mjs`（朝のまとめ）。

## 完了条件
1. 下記 件1〜件6 が実装済みで、`node --test tools/*.test.mjs` が緑（既存テストを壊さない）。
2. `node tools/deadline-detect.mjs --dry-run --fixture tools/fixtures/deadline/` が、同梱フィクスチャから期限候補を JSON で出す（Gemini はモック可。実ネットワーク不要）。
3. `node tools/deadline-watch.mjs --dry-run --now 2026-11-04 --fixture tools/fixtures/deadline/ledger.json` が、段階ルールどおりの通知行を出す。
4. `node tools/kim-inbox.mjs --context` の出力で kind=deadline が ask/info より前に出る（テストで固定）。
5. `docs/deadline-watch.md` に使い方・列定義・状態遷移・通知段階・運用ルールを書く。
6. commit は「件ごとに 1 commit」、ファイルはパス指定で add（`git add -A` 禁止）。push / PR は作らない（起動側スクリプトが行う）。

## 実装対象（本リポジトリ = この作業ツリー）

### 件1: 台帳の定義と初期化 `tools/deadline-ledger.mjs`（lib）
- 設定 `~/.claude/deadline-watch/config.json`（`ORGIAST_HOME` を尊重）: `{ sheetId, mailboxes: ["kim@orgiast.jp","seisaku-team@orgiast.jp"], driveUsers: 同上, lineSheets: ["1sCzmIvFmd2ZnDR2ZUMXmiIKjMJ21O9yMR6trY5e9JGo","1RRBNc_2Dvf5v0vdP2M7OHb6b9KhaNy9AoNo1MhZkUDI"], vehicleSheetId: "1mo8-hSCA-qDgblGBND-mjPEAF5fZ73etoz_mPeMZMLA", kimNames: ["kim","金","金功勇",""], calendar: { enabled: true, calendarId: "kim@orgiast.jp" } }`。
- `--init`: sheetId が無ければ DWD（impersonate kim@orgiast.jp）で「期限台帳」を新規作成し、タブ `期限台帳`・`候補`・`使い方` を作り、seisaku-team@ と cr@ に編集権限を付け、config に sheetId を書く。作り方は `vehicle-inspection-watch` の台帳作成経路（今日の実装）を踏襲。
- タブ `期限台帳` の見出し（1 行 1 義務）: `ID | 件名 | 種別 | 会社 | 期限日 | 残日数 | 状態 | 担当 | やること | 根拠 | 出典 | 出典ID | 検出日 | 最終通知日 | 通知回数 | 完了日 | 備考`。ID は `D-001` 連番。
- 種別: `車検 / 訴訟・法務 / 行政・消防 / 補助金・申請 / 契約更新 / 支払 / 回答・返信 / 提出 / その他`。状態: `候補 / 未着手 / 対応中 / 完了 / 不要 / 延期`。
- 初期データ `~/.claude/deadline-watch/seeds.json`（このPCに置いてある。無ければスキップ）を `--init` で取り込む（出典ID で重複排除）。
- Sheets の値は RAW で書く（数式注入防止。line-history-sync と同じ）。

### 件2: 自動検出 `tools/deadline-detect.mjs`（毎晩 02:40）
- 入力源と透かし（`~/.claude/deadline-watch/state.json` に源ごとの最終処理時刻）:
  1. Gmail: mailboxes ごとに `newer_than:3d -category:promotions -category:social -list:googlegroups-manage` を `gmail-search` のライブラリ関数で取得（1 箱 80 通/日 上限）。件名+snippet がキーワード正規表現（`期限|締切|締め切り|まで(に)?|満了|提出|回答|返送|納期|支払期日|振込期日|更新|期日|催告|督促|裁判|訴訟|答弁|準備書面|消防|質問書|届出|申請|報告書`）に当たるものだけ本文を取る。自社の自動通知（fleet-mail、Claude の報告、GitHub、noreply の自動返信）は除外。
  2. Drive: driveUsers ごとに `modifiedTime > 透かし` のファイルを DWD で列挙（50 件/日 上限）。Google ドキュメント・PDF・画像（Drive の OCR 変換 `files.copy` で Docs 化→テキスト export）を 30KB まで読む。
  3. LINE: lineSheets の新規行（`ts > 透かし`）。
  4. Discord: `~/.claude/discord-inbox-state.json` 経由の取込（discord-inbox-intake の出力があればその新規分）。
- 抽出は `llm-ask.mjs --provider gemini`（失敗時 `--provider openrouter`）。**Claude API は禁止**（ONBOARDING §2.8.0）。入力は源ごとに 10 件ずつまとめ、出力は JSON `{ items: [{ title, due: "YYYY-MM-DD"|null, kind, company, action, assignee, confidence: 0..1, quote, sourceRef }] }`。相対表現（「1 週間以内」「明日まで」）はメッセージ日付から絶対日にする。期限が本文に無いものは作らない（推測禁止）。
- 判定: `confidence >= 0.8 かつ due あり` → `期限台帳` に `状態=未着手`。それ以外で `種別 ∈ {訴訟・法務, 行政・消防, 補助金・申請}` または `confidence >= 0.5` → `候補` タブ。重複は `出典ID` 一致、または `件名の正規化一致 かつ 期限日 ±2 日` で捨てる。`完了/不要` の行と同じ出典IDは再登録しない。
- 担当の既定: 支払（振込期日）は `経理`、それ以外は `kim`。宛先が coordinate@/keiri2@/assing@ などのグループの場合は本文の宛名から担当を推定し、分からなければ `kim`。
- 出力: 追加件数・候補件数を stdout（JSON）と `~/.claude/deadline-watch/detect-log.jsonl` に残す。候補が増えた日は kim-inbox に `info` 1 行だけ（「候補 N 件。台帳の『候補』タブで承認/不要」）。
- `--dry-run` と `--fixture <dir>`（Gmail/Drive/LINE の JSON 固定入力と Gemini 応答のモック）を必ず実装。テストはフィクスチャで。

### 件3: 追跡・通知 `tools/deadline-watch.mjs`（毎朝 08:30）
- `期限台帳` と `車検台帳`（読み取りのみ。`種別=車検`、ID は `V01` 等をそのまま）を読み、`残日数` を書き戻す。
- 通知段階（期限までの日数。超過後は毎日）: 既定 `30,14,7,3,1,0`。種別別: `訴訟・法務 30,14,7,3,2,1,0` / `契約更新 60,30,14,7,1,0` / `支払 7,3,1,0` / `回答・返信 3,1,0`。`状態=対応中` は `3,1,0` と超過のみ。`完了/不要` は通知しない。`延期` は備考の新日付で再計算。
- kim に出す行の条件: `担当 ∈ kimNames` または `残日数 <= 3` または超過。それ以外（担当が他の人）は台帳と朝のまとめだけ。
- kim-inbox への投入は `node tools/kim-inbox.mjs --add --kind deadline --key <ID> --body-file <f>`（件4 の upsert）。1 行形式: `🔴 D-003 期限切れ 10/27｜V220d 車検（担当 kim）→ 入庫手配｜根拠: <URL>`。🔴=超過または ≤3 日、🟠=≤14 日、🟡=それ以外。
- 自動クローズ（kim の手を使わない）: `種別=回答・返信` で出典が Gmail のとき、同スレッドに自社からの SENT が検出後にあれば `状態=完了`。`車検` は車検台帳の状態に従う。`支払` は `完了日` が入ったら。クローズ時は kim-inbox の該当 key を `--close-key` で消す。
- 手動操作（セッションで Claude が叩く）: `--done <ID> [--note]`、`--defer <ID> --until YYYY-MM-DD`、`--drop <ID>`（状態=不要）、`--approve <候補行番号|全部>`（候補→未着手）。いずれも台帳を更新し kim-inbox を閉じる。
- `--digest`: 「今週の期限」ブロック（14 日以内と超過、担当つき、台帳 URL）を stdout に出す。`tools/auto-progress-digest.mjs` の朝のまとめの先頭に組み込む（既存のまとめ書式を壊さない）。
- カレンダー: `calendar.enabled` のとき、`未着手/対応中` の各行を kim@ の Google カレンダーに終日予定「【期限】<件名>」（通知 7 日前・1 日前、説明に台帳 URL）として DWD で upsert（`https://www.googleapis.com/auth/calendar.events`、予定の extendedProperties.private.deadlineId で冪等）。**403（スコープ未付与）なら一度だけログに残して `calendarSync:false` を state に書き、以降は試みない**（kim に DWD スコープ追加を頼むかは Claude 側で判断する）。
- 稼働監視: `tools/lib/heartbeat.mjs` の `reportHeartbeat` を呼び、`tools/nightly-health-expectations.json` に `OrgiastDeadlineDetect` と `OrgiastDeadlineWatch` の鮮度期待（LastRunTime 36h 以内）を足す。

### 件4: kim-inbox の期限レーン（`tools/kim-inbox.mjs`）
- `kind` に `deadline` を追加。`--add --kind deadline --key <ID>` は同じ key の open 項目を**置き換える**（upsert。通知回数は増やさない）。`--close-key <ID>` で消す。
- `selectContext`: 見出し行の直後に `[期限 N 件 — 期限台帳 <URL>] 返事は「D-003 完了」「D-003 延期 11/20」「D-003 不要」で可（Claude が node tools/deadline-watch.mjs --done/--defer/--drop で台帳と inbox を更新する）` を出し、deadline を**残日数の少ない順に最大 5 行**、各行 140 字まで。その後に従来の ask 5 件・info 3 件。`CONTEXT_LIMIT` 内に収める（deadline 優先）。
- 件数表示は `[kim-inbox 期限 N / 未回収 ask N / 未確認 info N]` に変える。
- テスト: 並び順・上限・upsert・close-key・既存 ask/info の挙動不変。

### 件5: kim-inbox のノイズを発生源で止める
- `別のパソコン（…）へ送った連絡が届いていない／読まれていない／届いていません` 系の info（現在 580 件超）は、発生源（`grep -rn "送った連絡が届いて" tools/` で特定。fleet-mail の watchdog / fleet-chase / notify-kim 経由）で **kim-inbox に入れず fleet-chase の台帳だけに残す**ようにする。kim に出すのは fleet-chase が「kim の判断が要る」と分類したものだけ。
- `source=gate-report` の info は kim-inbox に入れない（ゲートの統計は cost-directive 側で見えている）。
- 一回限りの掃除: `node tools/kim-inbox.mjs --seen-matching "<正規表現>" --kind info` を追加し、docs に「初回は `--seen-matching "送った連絡が(届いて|読まれて)"` と `--seen-matching "^gate-report"` を実行する」と書く（実行は Claude の検証セッションが行う）。

### 件6: 登録・配布・文書
- `tools/register-deadline-watch-tasks.ps1`: `OrgiastDeadlineDetect`（毎日 02:40）と `OrgiastDeadlineWatch`（毎日 08:30）を `register-vehicle-inspection-task.ps1` と同じ方式（wscript run-hidden.vbs → node）で登録。kim 席（`lib/kim-operated.mjs` の判定）だけに登録し、他 PC では no-op。`setup.mjs --converge` / `register-nightly-tools` の同じ経路に組み込む。
- `tools/vehicle-inspection-watch.mjs` の kim-inbox 投入を `--kind deadline --key <車両ID>` に切り替える（同じ車が ask と deadline の両方に出ないように）。
- `docs/deadline-watch.md`（使い方・列・状態遷移・段階・担当ルール・候補の承認方法・自動クローズ・カレンダー・掃除コマンド）。`HANDOVER.md` に 1 行追記（台帳の所有者と移管時に変える値）。

## 禁止・注意
- 社外への送信は一切しない（通知先は kim-inbox・台帳・kim のカレンダーのみ）。
- Claude API / `@anthropic-ai/sdk` を使わない。Gemini → OpenRouter の順。
- ネットワークやこのPCの鍵（`~/.claude` 配下）に依存するテストを書かない。ライブ確認は Claude の検証セッションが行う。
- 既存ファイルを壊さない。`node --check` が通ること。日本語でコミットメッセージを書く。
- 時間切れで全部できない場合は、件4 → 件5 → 件1 → 件3 → 件2 → 件6 の順に価値が高い。できた件までをコミットし、残りを `docs/codex/deadline-watch-20261105.md` 末尾の「## 残件」に書く。

## 残件
- 件1〜6の実装は完了。元のGit管理領域が読み取り専用のため、6コミットはbundleで納品。後続セッションで `node tools/restore-deadline-commits.mjs` を実行し、元ブランチへ取り込んでから起動側のpush/PR処理を続ける。
- 指定の全体テストは **全面green未達**。Windows連携を分けた515ファイルの実行では8,241成功・2失敗・43skip。2失敗のうちsetup隔離テストの追加依存漏れは修正して単独再検証成功。残るWindows PowerShellのMSIモック実行は30秒上限で失敗。既存nightly-lane-probeもWindowsネイティブNodeで4ケースが15秒上限で失敗し、repair-task-pathsは完走未確認。これらの本体実装は変更していない。単独の PowerShell `exit 0` も31.21秒かかることを実測した。通常速度でPowerShellが起動できる検証環境で全体を再実行する。
- 本番の `--init`、タスク登録、既存info掃除、ライブdry-run、Calendar/DWD確認は、指示どおり後続の検証セッションで実施する。今回の新規テストはネットワーク・鍵・実ホームに依存しない。
- 証拠は `reports/deadline-watch-20261105/verification.json` と同フォルダのログ。検出フィクスチャは追加5件・候補1件、追跡フィクスチャは5通知。関連135テスト、追加の台帳・追跡13テスト、期限inbox21テスト、履歴復元テスト等はすべて成功。

### Codex 実装記録（2026-11-05）

件1〜6を実装。固定入力の検出・追跡、期限レーン、ノイズ抑止、初期化、自動完了・Calendar、タスク登録・配布を追加。実装の使い方は [期限台帳](../deadline-watch.md)。本番の初期化・掃除・タスク登録・送信は未実行で、指示どおり後続検証セッションの対象。

Git管理領域 `/mnt/c/Users/uers/Downloads/orgiast-claude-rules/.git/worktrees/deadline-watch` が読み取り専用で、通常の `git add` は `index.lock: Read-only file system`。実装ファイルはこのツリーに保存し、書込可能な独立Git管理領域で件別コミットを作成した。履歴は `reports/deadline-watch-20261105/deadline-watch.bundle`、基点・先端は同フォルダの `commits.json` に保存する。後続の検証セッションは **push前に** `node tools/restore-deadline-commits.mjs` を実行して取り込む。現在のブランチ・基点・ステージ済み変更・各変更ファイルの内容を照合し、不一致なら変更せず停止する。Windows用の同じ入口は `tools/restore-deadline-commits.cmd`。push／PRは作成していない。

### Codex 仕上げ検証（2026-11-05）

- Gmailの返信済み照合で通信エラーになると、その行の期限通知まで省略される不具合を回帰テストで再現して修正。完了の証拠が取れない行は未完了のまま通知し、`errors` に `phase: auto-close` を残す。
- 修正後の関連68テストが成功。指定の固定入力も検出5件・候補1件、追跡5通知、エラーなしを再確認。
- setupの既存テストも再実行し、隔離依存の修正は成功。Windows PowerShellのMSIモックは再び30秒タイムアウトで失敗。全体greenの完了条件は引き続き未達であり、本番検証も未実施。
- 原Git管理領域への `git add -- docs/deadline-watch-claim.md` は今回も `index.lock: Read-only file system`。修正は件3のコミットへ反映し、6コミット構成のbundleと照合記録を更新した。push/PRは行っていない。
