# kim 宛通知を Discord から全廃しセッション 1 画面へ

## 概要

kim 宛の通知（進捗まとめ・完了通知・判断待ち・配送警告・社外返信待ち）を **Discord に一切送らず、セッション内に 1 画面で出す**。全アカウント・全 PC・全 Claude Code に同じ挙動を配布し、再び Discord へ戻す変更が CI で落ちるようにする（kim 2026-11-09 指示「discord に通知しない。多すぎて見れないから全体が止まる。セッションに入れ込む。全アカウント全PCで汎用ルール化」）。

## 現在のルール

- **ONBOARDING.md 722 行**: 「kim 宛の定期ダイジェスト・完了通知・配送異常の警告はすべて kim-inbox へ保存する。Discord DM は全廃・例外なし（kim 2026-11-06）」（PR #1630）。
- **PR #1688（11/08「完了通知・進捗まとめを kim の Discord へ確実に届ける」）**: `config/kim-discord-allowlist.json` に entries を戻し、`notify-kim.mjs`／`lib/auto-progress-done-inbox.mjs`／`lib/owner-dm-policy.mjs` で Discord 送信を復活させ、`tools/kim-no-dm.test.mjs` と `kim-discord-allowlist.test.mjs` を書き換えて通した。送信記録 `~/.claude/logs/auto-progress-digest.sent.jsonl` で 11/08 夕以降 channel=discord。ルールとコードが食い違い、ルールを守るテストが「書き換えれば通る」形。

## 新規ファイル: docs/kim-progress-channel.md の内容

### 1. Discord DM 禁止

- kim 宛の通知は **Discord へ送らない**（例外なし）。許可リストは廃止＝ファイルは残しても entries は常に空で、テストが空を要求。

### 2. 届け先

- kim 宛の通知は kim-inbox のみ（`tools/notify-kim.mjs` は常に addItem→session-inbox）。

### 3. kim-inbox の表示

- SessionStart と UserPromptSubmit で **1 画面（合計 6KB 以下）** だけ表示:
  - 先頭に「【進捗まとめ】」
    - a) kim の判断待ち上位 5 件（1 件 1〜2 行・何を決めるか・返答コマンド不要、答えは会話でよい）
    - b) 昨日〜今日の完了（席名＋案件名、最大 5 件）
    - c) 止まっている（最大 3 件）
    - d) 件数行（ask N／info N／返事待ち N）
  - 残りは `node tools/kim-inbox.mjs --list --open` へ

### 4. 進捗まとめ（朝のダイジェスト）

- Discord ではなく kim-inbox に **1 日 1 件に置き換え**（既存の `dailyProgress`／`progressDay`／`replaceExisting` 機構を使う）。席ごとの別アイテムにせず、fleet 経由で届く他席分も同じ日付キーに統合する。

### 5. 完了通知

- kim-inbox だけ（`tools/lib/auto-progress-done-inbox.mjs` の Discord ミラーを削除）。

## 変更するコード

### tools/

1. **tools/notify-kim.mjs**
   - kim 宛の通知は常に `addItem→session-inbox`、Discord 分岐を削除

2. **tools/lib/auto-progress-done-inbox.mjs**
   - `mirrorToDiscord` 削除

3. **tools/lib/owner-dm-policy.mjs**
   - kim 宛の通知は常に addItem→session-inbox、Discord 分岐を削除

4. **tools/lib/kim-discord-allowlist.mjs**
   - `discordAllowed` は常に `false` を返すか削除

5. **config/kim-discord-allowlist.json**
   - `entries: []`

6. **tools/auto-progress-digest.mjs**
   - kim 宛の通知は inbox の日次 1 件へ、Discord 送信なし

7. **tools/kim-inbox.mjs**
   - SessionStart 注入を **1 画面化・6KB 上限**、判断待ち上位 5 件表示

8. **tools/kim-awaiting.mjs**
   - SessionStart 表示を件数＋上位 3 件に

### docs/

- **docs/kim-progress-channel.md** を作成（新規）

### ONBOARDING.md & CLAUDE.md

- 該当行を `docs/kim-progress-channel.md` を参照する 1 行へ

## 退行防止テスト（強化版）

### tools/kim-no-dm.test.mjs

- (a) ONBOARDING.md に「Discord DM は全廃」の行があることを読み、その場合 `config/kim-discord-allowlist.json` の entries が空であることを要求
- (b) `notifyKim`／`deliverKim`／`notifyOwner`／`deliverDoneInbox` を kim 宛で呼び、fetch モックが Discord API を **1 回も呼ばない**
- (c) digest の receipts channel が `kim-inbox`／`session-inbox` のみ
- (d) SessionStart 注入文字列が 6KB 以下（ask 300 件・info 300 件の合成台帳で）

## 規約

- node:test、依存追加なし、`windowsHide: true`、共有クローン直編集禁止（worktree）、実送信はテストでしない
- 既存 kim-inbox の 450 件は消さない（表示から外すだけ）
- 言い換えで権限ゲートを回避しない

## ADDENDUM（2026-11-09 22:35 JST・セッション 96005bd5 で実測した追加の型）

- 「止まっている」欄に、auto-progress の check が **相手側の停止で永久に未達になる行** も出す。実例: 古川さん報酬 DM の読取照会（fleet-mail mail-1794229107588-999e8c4c → kim-PC）。kim-PC の fleet poll が 11/09 21:25 で止まり（fleet-status 実測）、`--sent-status` は「hub不達」で exit 3、check は grep で exit 1＝「未達」と同じ扱いになり、kim にはどこにも出なかった。対策: check の stderr にエラー語（hub不達・timeout・EBUSY・403 等）が 2 回連続したら「止まっている（原因: <stderr 1行>）」として 1 画面の c) に載せる。

- Claude がセッション内のバックグラウンド待機（Bash run_in_background の until ループ・Monitor）で「このセッションで1分ごとに確認」と約束しても、セッションが閉じると止まり（task status=stopped）、結果は誰にも出ない。kim が 22:28 に「進捗どう？」と聞いた。対策: 応答の「この後の自動進行」に「このセッションで」「1分ごと」等のセッション内待機だけを書いた場合、台帳に同じ内容の check 行（--add-check）が無ければ Stop ゲートで差し戻す（unregistered-promise-gate の拡張）。テスト 1 本追加。

## 参考

- kim-inbox.mjs 337 行の fleet 受信で `dedupeKey: auto-progress-daily:<id>`・`replaceExisting`・`dailyProgress`・`progressDay` が既にある。

## DONE_CRITERIA

1. `docs/kim-progress-channel.md` があり、ONBOARDING/CLAUDE.md の該当行がそれを参照
2. `node --test tools/kim-no-dm.test.mjs tools/kim-inbox.test.mjs tools/auto-progress-digest.test.mjs tools/progress-delivery.test.mjs tools/no-visible-console-window.test.mjs` pass（kim-discord-allowlist.test.mjs は「entries が空」を要求する内容に書き換え）
3. 実台帳で `node tools/kim-inbox.mjs` の SessionStart 注入を生成し、文字数 ≤ 6KB・先頭が「【進捗まとめ】」・判断待ち上位 5 件が名前付きで入る
4. `node tools/auto-progress-digest.mjs --dry-run` の receipts channel に discord が無い
5. PR 作成（タイトル `feat(progress): kim 宛通知を Discord から全廃しセッション 1 画面へ（全PC共通・退行は CI で停止）`、本文末尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`、commit 末尾 `Co-Authored-By: Claude Fable  முடிய5.1 <noreply @anthropic.com>`）

## OUTPUT

- PR URL、注入サンプル（先頭 40 行）、テスト結果

## REPORT_TO

`C:\Users\kimko\.claude\booth-3d-poc\RESULT-progress-channel-v2.md`
