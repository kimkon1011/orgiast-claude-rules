# fleet-mail v2 設計（PC 間 Claude Code 連絡の根本見直し）

作成: 2026-10-14 kim-PC（Claude Fable 監督）。実装は Codex。正本はこの文書と `tools/fleet-mail*.test.mjs`。

## 0. なぜ作り直すか（2026-10-12 事故の真因）

cr-PC → kim-PC の作業依頼 `mail-20261012125202282-6588` は 21:52 に配達されたが、kim-PC の Claude が読んだのは翌 10:42（13 時間後）。cr-PC には「配達済み」しか見えず「未着」と判断した。監査で分かった構造欠陥:

1. **サーバー（fleet シート GAS）が既読を持たない。** `delivered` は「受信 PC の poll が取った」だけで、Claude が読んだか・返したかはどこにも無い。
2. **宛先が部分一致。** `label.indexOf(to)` のため `kim` や `作業用01` が複数 PC に当たり、最初に poll した PC が消費する。返信も同じ経路で迷子になる。
3. **受信側は対話セッションでプロンプトが打たれるまで誰も見ない。** hook は UserPromptSubmit のみ。夜間・不在は無限に待つ。
4. **hook が古い順・1500 字で打ち切る。** 未読 108 通の状態では最古の数通で枠が埋まり、新着は永久に出ない。
5. **処理済みの二重管理。** `.fleet-mail-processed`（poll）と inbox の `status/readAt`（reply/ack）が別。対話で返信済みでも poll が prompt を再実行して二重返信する。
6. **ループ防止が `[判断依頼]` 限定。** 通常の返信への返信が PC 間で往復しうる。
7. **hook が 5 秒 kill される設計で GAS 往復と lock を持つ。** lock が残ると定期受信が最大 10 分スキップ。
8. **poison message で受信バッチ全体が止まり、同じバッチが再生され続ける。**
9. **監視は kim-PC 単独・`new` のみ。** 「配達済みだが未読」は検知されない。
10. **健全性判定が LastRunTime のみ。** 毎回失敗しているタスクも ok。

## 1. 設計原則

- **正本はサーバー 1 か所。** 状態遷移はすべて Sheet に書き、送信側が `--sent-status` で「どこまで進んだか」を必ず見られる。ローカルの inbox はキャッシュ。
- **「最適なタイミング」= 到着時に分類して即時アクションを決め、人の注意が要るものだけ通知する。** 残りは次のセッション境界（SessionStart / UserPromptSubmit）で新しい順・優先順に提示する。
- **配達・既読・完了を分ける。** 送信側は seen を待てる。読まれていない作業依頼は 2 時間で SLA 超過として通知される。
- **自動生成メールは自動返信しない。** `auto`/`hop` で機械的にループを断つ。
- **1 通の失敗で他を巻き込まない。** 隔離して先へ進む。
- **後方互換。** 旧 CLI が新 GAS に、新 CLI が旧 GAS に当たっても壊れない（未知 action は警告のみ）。全 PC 同時配布でも受信が止まらない。

## 2. 状態機械（Sheet「fleet-mail」正本）

```
new ──poll──▶ delivered ──注入/閲覧/実行開始──▶ seen ──reply|ack──▶ done
                 │                                 │
                 └──────────── fail ───────────────┴──▶ failed
   いずれも expiresAt 超過で未 done ──GAS sweep──▶ expired
```

| 列 | 意味 | 書く主体 |
|---|---|---|
| status | new / delivered / seen / done / failed / expired | GAS |
| deliveredAt, deliveredBy | 受信 PC の poll が取得 | poll |
| seenAt, seenBy | Claude のコンテキストに注入された／`--inbox` で本文を読んだ／headless が実行開始（seenBy = ラベル + sessionId か `headless`） | 受信 CLI `mail-seen` |
| resultAt, resultBody | 返信 | `mail-reply` |
| ackAt | 返信不要の完了 | `mail-ack` |
| failedAt, failReason | 受信側で処理不能 | `mail-fail` |
| auto, hop | 自動生成フラグと世代 | 送信時 |
| priority | normal / urgent | 送信時（`--priority urgent`、`[判断依頼]`/`[作業依頼]` は自動で urgent） |

- 新 action: `mail-seen`, `mail-ack`, `mail-fail`。全て冪等。状態は前進のみ（done の後に seen を受けても done のまま、ok:true で返す）。
- `mail-get` / `mail-sent-status` は全時刻と deliveredBy/seenBy を返す。
- `mail-reply`: 相手が `auto=true` のメールへの `auto=true` 返信は `ok:false, reason:'loop'`。返信メールは `auto=false` でも `hop=parent.hop+1` を持ち、`hop>=3` の返信は拒否。

## 3. 宛先解決（完全一致）

- 正本: `tools/fleet-pc-map.json`（作業用番号⇔ラベル⇔hostname）＋ビーコンのラベル一覧。
- CLI `--to` の解決順: ①作業用番号→ラベル ②ラベル完全一致 ③hostname 完全一致（map か beacon に存在するもの） ④`all`。**部分一致は廃止。** 解決できなければ送らず exit 4 で候補（前方一致上位 5 件）を表示。
- CLI は解決後の **正規ラベル** を `to` に入れて送る。GAS の poll 側も `label === to || hostname === to` の完全一致のみ。
- 返信先は原本 `from`（送信時に正規ラベルで記録）なので一致する。
- 同一 hostname の複数ラベル（kimko-PC/作業用004）は従来 PR #751 の付替えを維持。

## 4. 受信（2 分 poll、`fleet-mail.mjs --poll`）

- `.fleet-mail-processed` を**廃止**し、処理済み判定は inbox の `status` に統一（`done/failed/expired` = 処理済み、`delivered/seen` = 未処理）。移行時は既存 processed の id を inbox に反映して削除。
- prompt の自動実行条件: `status ∈ {delivered, seen}` かつ `executionStartedAt` 無し。対話で `--reply` 済み（done）は再実行しない。
- 1 通ごとに try/catch。不正メールは `~/.claude/fleet-inbox/quarantine/<id>.json` に退避し `mail-fail(reason)` を送り、バッチの残りは処理する。pollFile（再送レシート）は成功した id だけ確定する。
- 到着時の即時アクション（分類は `why`/本文先頭の `[判断依頼]`/`[作業依頼]`/`[回答・返信不要]`/`[回答]`/`priority`）:
  - `prompt` → 既存どおり headless 実行（オプトイン済みのみ）。実行開始時に `mail-seen(seenBy='headless')`。
  - `[判断依頼]` → pending-decisions 登録 ＋ 受領 ack（auto=true）＋ Discord 通知（§7）。ヘッドレスは答えない（既存）。
  - `[作業依頼]` / `priority=urgent` → Discord 通知（§7）。本文は注入待ち。
  - 返信メール（`mail-reply-*`） → 原本が `fleet-mail-sent.jsonl` にあれば `resultBody` を結合して保存。hook は `[回答・返信不要]` として 1 回注入し、注入後に自動 `mail-ack`。
  - その他 note → 待機。
- 期限切れ（expiresAt 超過・未 done）はローカルで `expired` にして提示から外す（サーバーは §7 の sweep が付ける）。
- `mail-seen`/`mail-ack` の送信失敗は inbox に `pendingServer:['seen']` を残し、次の poll で再送（最終的整合）。

## 5. 提示（hook `fleet-inbox-context.mjs`）

- 発火: **SessionStart と UserPromptSubmit** の両方。
- hook は **GAS と通信しない**（5 秒 kill 対策）。`.fleet-mail-last-poll.json` が 3 分より古ければ `fleet-mail.mjs --poll` を detached で spawn して今回はローカル分だけ出す。lock は poll 専用で hook は持たない。
- 表示順と上限（1 通 240 字、全体 1800 字）:
  1. 未回答 `[判断依頼]`（最大 3）
  2. 未 seen の `[作業依頼]` / urgent（最大 3）
  3. 未 seen の返信 `[回答・返信不要]`（最大 3、注入後に自動 ack）
  4. その他 未 seen note を **新しい順**（最大 2）
  5. 末尾 1 行: `他 N 件（期限切れ M 件は除外）: node tools/fleet-mail.mjs --inbox --unseen`
- 注入したものは inbox に `presentedAt`, `presentedSession` を書き、`mail-seen` を detached spawn で送る（fire-and-forget、失敗は §4 の再送）。
- 同じセッションで提示済みのものは全文を再注入せず件数行だけに含める。別セッションでは done まで再提示。
- `--ack <id>`、`--ack --all-seen`（提示済み一括）、`--reply` で done。

## 6. 送信側の見え方

- `--send` 後に 1 行で状態確認の手順を出す（`--sent-status <id>`）。
- `--sent-status` は new/delivered/seen/done/failed/expired と各時刻・deliveredBy・seenBy を表示。
- `--wait` は `--wait-for seen|done`（既定 done）。seen を待てば「読まれた」時点で戻れる。
- id は `mail-<ms>-<8 hex 乱数>`。GAS が `duplicate:true` を返したら id を再生成して 1 回だけ再送（それでも duplicate なら exit 1）。

## 7. 監視（サーバー側に移す）

- GAS 時間トリガー `fleetMailSweep`（10 分毎、`setupFleetMailTriggers()` で冪等登録）:
  - (a) expiresAt 超過・未 done → `expired`。
  - (b) delivered で seen なしが **2 時間**超（urgent）／**6 時間**超（normal）→ アラート「未読 SLA 超過」。
  - (c) new で delivered なしが **30 分**超 → アラート「未配達（受信タスク停止の疑い）」。
  - アラートは Sheet タブ `fleet-mail-alerts`（id, kind, to, from, why, firstAt, lastNotifiedAt）に 1 id 1 行で upsert。6 時間ごとに再通知可。ScriptProperties `FLEET_MAIL_DISCORD_WEBHOOK` があれば GAS から直接 Discord `#claude-code` へ投稿（UrlFetchApp）。無ければタブ記録のみ。
- kim-PC の `fleet-mail-watchdog.mjs`（毎時、既存）は `fleet-mail-alerts` タブを読み、未通知分を Discord `#claude-code` と kim の DM に投稿（webhook 未設定時のフォールバック）。従来の `new` 監視は GAS 側へ移す。
- 到着通知（§4）: 受信 PC の poll が `[判断依頼]`/`[作業依頼]`/urgent の到着時に `#claude-code` へ 1 行投稿（`<宛先ラベル> 宛 <種別> 到着: <why 60 字> / id`）。既存の Discord 投稿経路（`tools/notify-kim.mjs` か discord-inbox-intake が使う webhook）を流用し、無ければ黙ってスキップ（stderr に 1 行）。1 id 1 回。
- `register-fleet-mail.mjs --ensure`: 判定を **LastTaskResult≠0 または last-poll が 10 分より古い** に変更し、該当なら再登録＋即 1 回 poll。SessionStart hook からも `--ensure --quiet` を detached で呼ぶ（日次 03:15 を待たない）。

## 8. 一括掃除（移行）

- `fleet-mail.mjs --sweep`: ローカル inbox の期限切れ・72 時間超の返信メール・`[回答・返信不要]` を `expired`/`done` にし、サーバーへ `mail-ack`/`mail-fail(expired)` を送る。`[判断依頼]` の未回答は残す。結果を件数で表示。
- converge の `task:fleet-mail` ステップは、新版導入時に 1 回だけ `--sweep` を実行（`~/.claude/.fleet-mail-v2-migrated` マーカー）。

## 9. 配布と互換

- GAS `Mail.gs` は旧 CLI の poll/reply を壊さない（新列は任意、未知フィールドは無視）。新 CLI は旧 GAS に当たると `mail-seen` 等が unknown action でも警告 1 行で続行。
- 本番反映: Mail.gs は `gas-overlay-push.mjs --project <一時dir> --files Mail.js --deploy-webapp`（kim-PC で Claude が実行）。CLI・hook・タスクは `setup --converge`（`tools/fleet-scope.json` の `task:fleet-mail`）で全 PC へ。
- `docs/PC名簿.md` と `skills/fleet-mail/SKILL.md` を v2 の挙動（完全一致・seen・--wait-for・--sweep）に更新。

## 10. 完了の定義

- 単体: `node --test tools/fleet-mail*.test.mjs tools/fleet-inbox-context.test.mjs tools/fleet-poller*.test.mjs tools/fleet-mail-gas.test.mjs` 全 pass。GAS ロジックは既存流儀どおり `.gs` を読み込んで `new Function` で評価するテストで固定。
- 実機（kim-PC）: 自分宛に `--send --to kim-PC --kind note --why "[作業依頼] v2 実測"` → 2 分以内に delivered → 新セッションで hook が提示 → `--sent-status` が seen → `--ack` で done。`--to kim`（部分一致）が exit 4 で候補表示になる。

## 11. kim-PC ハブ（司令塔）モード — 各 PC の質問を kim-PC で回収し、kim-PC から答えて相手セッションを進める

目的: kim は kim-PC の Claude Code とだけ話していれば、cr-PC / nishi-PC など各 PC の Claude Code セッションが止まらずに進む。

### 11.1 流れ

```
[相手PC] セッションが user に質問して停止（AskUserQuestion か、最終応答が質問で終わる）
   └ Stop hook fleet-question-relay.mjs が質問を ~/.claude/fleet-questions/<session>.json に記録（即時送信はしない）
   └ 2分 poll が「質問が記録されてから 10 分、同セッションに新しい user 発話が無い」ものを
     [判断依頼] として kim-PC へ送る（本文: PC ラベル・質問全文≤2000字・選択肢・cwd・sessionId・直近の作業要約≤600字）
     相手PC の UserPromptSubmit hook はその質問に「kim-PC へ転送済み・回答待ち」と表示する
[kim-PC] hook が [判断依頼] を最優先で提示（到着時に Discord #claude-code にも 1 行）
   └ kim が kim-PC の Claude に答える（「A で進めて」など）
   └ Claude が `fleet-mail.mjs --answer <判断依頼id> --body-file <回答>` を実行
      = 原本を done にし、相手PC へ kind=prompt・exec=resume（resumeSessionId, cwd）の mail を送る
[相手PC] poll が prompt(exec=resume) を受信 → オプトイン済みなら
     `claude -p --resume <sessionId> "<回答>"`（cwd=元の作業ディレクトリ、相手PC 自身の Claude アカウント）を headless 実行
   └ 完了出力（最終応答）を返信として kim-PC へ（[報告・返信不要]）
   └ 再び質問で止まれば Stop hook → 10 分ルールを待たず即 [判断依頼]（hub 駆動セッションは待たない）
```

### 11.2 ルール

- **相手PC の人を飛び越えない**: 対話セッションで出た質問は 10 分間は相手PC の人のもの。10 分経っても新しい user 発話が無いときだけ kim-PC へ転送する。hub から resume で再開されたセッション（`~/.claude/fleet-questions/<session>.json` に `drivenByHub:true`）は即転送。
- **オプトイン**: 相手PC の人が `fleet-agent-optin.json` の accept に `prompt` を一度入れている必要がある（既存ルール。AI が代行しない）。未承諾なら承諾コマンドが kim-PC に返り、kim-PC の hook は「<PC> は未承諾。承諾コマンドを本人に渡す」と表示する。
- **同時編集の衝突回避**: resume 実行中は `~/.claude/fleet-questions/<session>.json` に `resumingAt` を書き、相手PC の UserPromptSubmit hook が同じセッションで「kim-PC の回答で実行中（N 分前開始）」と表示する。resume は 1 セッション同時 1 本。実行上限 30 分。超過は fail 返信。
- **kim-PC 側の見え方**: 判断依頼の提示に `回答: node tools/fleet-mail.mjs --answer <id> --body-file <file>` を付ける。回答後、相手PC からの報告は `[報告・返信不要]` として提示され、自動 ack。
- **kim から能動的に進める**: `--send --to <PC> --kind prompt --exec claude --exec-cwd <path> --resume <sessionId>`（sessionId 省略時は新規セッション）で、kim-PC から相手PC のセッションを開始・再開できる。`--exec codex` は従来どおり。
- **質問の検出**: Stop hook は (a) 最後のアシスタント発話に AskUserQuestion の tool_use が含まれる、(b) 最終行が「?／？」で終わる、または「どうしますか／どちらにしますか／選んでください／確認してください／教えてください」を含み、かつ手順・コード断片で終わらない、のいずれか。誤検出は 10 分ルールと「同セッション同質問は 1 回」で吸収する。
- **秘密情報**: 転送本文は redactSecrets を通す。transcript 本体は送らない。

### 11.3 配布

- 相手PC: Stop hook と UserPromptSubmit hook の登録、`fleet-sheet.env` に `FLEET_HUB=kim-PC`（converge `task:fleet-mail` に含める。kim-PC 自身は FLEET_HUB 無し＝転送しない）。
- kim-PC: `--answer`、hook の提示文言。

### 11.4 安全規約（2026-10-14 レビュー反映・§11.2 を上書き）

- **承諾キーの分離**: `exec=claude`（フル権限の `claude -p --resume`）は `fleet-agent-optin.json` の accept に **`claude-resume`** が入っている PC だけが実行する。従来の `prompt`（読み取り専用の回答）承諾では実行しない。未承諾なら承諾コマンド（`claude-resume` 用）を kim-PC に返す。
- **送信元の限定**: `exec=claude` は `from` が自 PC の `FLEET_HUB`（kim-PC）と完全一致するときだけ受理。それ以外は fail 返信（reason: not-hub）。
- **cwd の検証**: `execCwd` は「存在し、`.git` を持つディレクトリ」のみ。不合格は fail 返信。
- **引数の終端**: 本文は `--` の後ろに置く（本文が `--` で始まってもフラグとして読まれない）。
- **実行は detached runner**: `exec=codex` と同じく poll の lock を 30 分占有しない。実行中は `fleet-questions/<session>.json` の `resumingAt` で同時 1 本を保証。
- **drivenByHub の寿命**: resume の終了（成功・失敗・30 分超過）で解除する。以後その セッションで現地の人が出した質問は 10 分ルールに戻る。
- **AskUserQuestion の捕捉**: 対話セッションの AskUserQuestion はターンが終わらず Stop hook が発火しないため、**PreToolUse（matcher: AskUserQuestion）hook** で質問と選択肢を `fleet-questions/` に記録する。Notification hook（permission 要求・idle）も同様に記録する。kim-PC の回答で再開されるのは `--resume` による分岐セッションであり、元の対話画面に残った質問は Esc で閉じてよい（表示に明記）。
- **`--answer` の検証**: 原本の `to` が自ラベルでなければ exit 2。同じ id への再実行は「前回の回答を再送」と明示し、本文が違えば `--force` 無しでは送らない。

## 12. #802/#799/#800/#801 自動回答の回収（2026-10-15）

- 通常promptも `fleet-task-runner.mjs` をdetached起動し、pollは待たない。読み取り専用の引数・headerは維持。`fleet-sheet.env` の `FLEET_PROMPT_TIMEOUT_SEC` は既定600秒、上限1800秒。不正値は既定値。結果は `fleet-agent-results/<id>.json` に保存し、次回pollが回収する。通常prompt/codexの結果未生成は35分（最大実行30分＋5分余裕）でtimeout。`executionStartedAt` のあるメールは再実行しない。
- prompt/codex/claude-resumeの結果判定は `classifyExecutionResult` に統一。stdoutから既知のPermission allow rule等の設定警告行を除いたものだけが回答。timedOut、非zero/null exit、本文空はそれぞれtimeout / exit-<code> / empty。旧結果の混合outputTailは回答として信用しない。
- 失敗時はmail-replyを呼ばず、失敗理由・受信PCの対話回答への案内・秘密除去後のstderr末尾600字を冪等なnoteで送り、mail-failで原本をfailedにする。送信に失敗した結果は保存して次回pollで再送する。受信hookはfailed promptを最優先の「[作業依頼] 自動回答できなかった質問」として原文・理由・`--reply <id> --body-file <file>` とともに提示する。
- GASはfailed→doneを許可しないため、failedへの対話 `--reply` は安定IDの新規note（replyTo付き）を送り、受信側ローカルをdoneにする。サーバー原本はfailedのまま。送信側はnoteの回答本文を回収してローカル表示を完了にする。
- 送信側pollは送信履歴からmail-getを巡回し `fleet-mail-sent-status.json` に保存。hookはネットワーク通信せず、failedの宛先・id・理由と対話回答待ち／再送案内を表示。`--sent-status` は従来どおりサーバーのstatus/failReasonを表示する。
- allow-rulesの無効なWrite(memory/next-session)2件は廃止一覧で既存settingsからも削除。Edit版と他のローカルルールを維持。
- Discord到着通知に `[fleet-arrival]` を付加。decision-watchはBot/webhook投稿、マーカー、従来の「宛 … 到着:」形式を除外。
- Notificationの権限確認文（needs your permission / permission to use / Claude needs your）は質問relayに記録しない。通常質問は維持。
- 本番pullのWebApp.jsからauto-progress/auto-progress-listのハンドラとコメントを復元し、AutoProgress.jsを正本AutoProgress.gsへ追加。本番デプロイはこの変更に含めない。

### 12.1 変更ファイル

- 実装: `tools/fleet-mail.mjs`, `tools/fleet-task-runner.mjs`, `tools/fleet-agent.mjs`, `tools/fleet-inbox-context.mjs`, `tools/allow-rules.mjs`, `tools/allow-rules.json`, `tools/decision-watch.mjs`, `tools/lib/fleet-mail-discord.mjs`, `tools/fleet-question-relay.mjs`
- テスト: `tools/fleet-mail.test.mjs`, `tools/fleet-mail-v2.test.mjs`, `tools/fleet-mail-watchdog.test.mjs`, `tools/fleet-task-runner.test.mjs`, `tools/fleet-inbox-context.test.mjs`, `tools/allow-rules.test.mjs`, `tools/decision-watch.test.mjs`, `tools/fleet-question-relay.test.mjs`
- GAS: `gas/fleet-status-sheet/WebApp.gs`, `gas/fleet-status-sheet/AutoProgress.gs`（本番pullと同一内容）
- 設計: `docs/fleet-mail-v2-design.md`

### 12.2 検証

指定の `node --test tools/fleet-mail*.test.mjs tools/fleet-inbox-context.test.mjs tools/fleet-poller*.test.mjs tools/fleet-task-runner.test.mjs tools/allow-rules.test.mjs tools/decision-watch.test.mjs tools/fleet-question-relay*.test.mjs` は385件pass / 0件fail。timeout時の警告stderr、警告だけのstdout、stdoutのみの返信、再送時の長文保持、failedへの対話返信、送受信hook表示、廃止ルール削除、通知・権限確認の除外を含む。

全体 `node --test tools/*.test.mjs` は出力進行が止まり中断。最終版で `node --test --test-timeout=30000 tools/*.test.mjs` も実行したが同じ位置で45秒以上出力が止まり、2178件pass / 1件failを観測した時点で中断（exit 130、全体完走ではない）。failは `distribution-coverage.test.mjs` の既存作業環境項目 `.agents`, `.codex`, `.codex-task-fleet-mail-collect.md` 未分類。単独再実行でも同じ1件fail（6件pass）。指定テストは全完走。コミット・本番配布・実PC送受信は実施していない。
