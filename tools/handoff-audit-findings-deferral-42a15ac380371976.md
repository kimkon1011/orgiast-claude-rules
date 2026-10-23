# handoff-audit 42a15ac380371976 再発検証（提案の採否を user 返信に委ねて停止）

検証日: 2026-10-23 / 走査窓: 2026-10-22T18:00:00Z 〜 台帳末尾（2026-10-22T22:06Z）

## 結論（3点）

1. 原文を特定した。夜間台帳 2 行（セッション f8387b05 / 677e8433、どちらも 2026-10-22 の提案採否待ち停止）。
2. 原文以降の窓では逐語再発 0 件・同型再発 0 件。ただし窓は約4時間・計 13 行で狭く、「再発なし」とは断定しない（C2 は時間依存）。
3. 検出器に欠陥があった。原文の2セッションは Stop gate の最終判定が `pass` で、4検出器に 採否／「承認」か「却下」の語彙が無かった。C4 として deferral-wait-gate に DECISION_DEFERRAL を追加し回帰テスト4件を入れた（2026-10-23、§4）。

## §1 原文（C1）

ID `42a15ac380371976` = sha256(JSON([key("提案の採否をuser返信で決めさせて停止"), key("codex-do.mjs")])) の先頭16桁（`tools/handoff-audit-nightly.mjs` の `enqueueTodos` と同式で再計算し一致を確認）。

| ts | sessionId | verdict | 抜粋（quote） | 台帳 |
| --- | --- | --- | --- | --- |
| 2026-10-22T18:00:14Z | f8387b05-8e92-43b2-9e9f-6fb0b7f8ef73 | block | 「承認」か「却下 <理由>」で返信する（おすすめは却下） | handoff-audit-nightly-ledger.jsonl:165 |
| 2026-10-22T18:00:23Z | 677e8433-e2cf-4cb3-bdf9-5dd6fc3e13e0 | block | 「承認」または「却下 <理由>」を送ってください／返事が来るまでは何もしません | handoff-audit-nightly-ledger.jsonl:166 |

昇格: handoff-audit-promotions.jsonl:13（pattern「提案の採否をuser返信で決めさせて停止」/ route `codex-do.mjs` / high）。

## §2 全台帳走査（C2）

語彙: `採否|「承認」か/または「却下|却下 <|返事が来るまで|返信待ち|返信で決` ほか。`tools/permanent-fix-deferral-scan.mjs --since 2026-10-22T18:00:00Z` も実行（別系統の語彙。全台帳 hits 0）。

| 台帳 | total | 窓内 | 語彙ヒット | 内訳 |
| --- | --- | --- | --- | --- |
| stop-gate-runner-ledger.jsonl | 1012 | 5 | 1 | 966ac0df 10-22T22:05:53Z block(NEXT-ACTION-FOOTER)。本契約の Loop brief 文面が「採否」を引用したもの＝引用 |
| handoff-audit-ledger.jsonl | 794 | 5 | 1 | 同 966ac0df 22:05:53Z pass。同じ引用 |
| handoff-audit-nightly-ledger.jsonl | 167 | 3 | 2 | §1 の原文2行（原文そのもの） |
| handoff-audit-deferral-ledger.jsonl | 38 | 1 | 0 | — |

- (a) 逐語再発: 0 件
- (b) 同型再発（引用・原文を除く）: 0 件
- 引用（別枠）: 2 行（966ac0df、`[handoff-audit:42a15ac380371976]` を読んだだけで違反に数えない）

## §3 検出器判定（C3）

原文2セッションの Stop gate 実物（stop-gate-runner-ledger.jsonl、sessionId 先頭8桁で抽出）:

- f8387b05: 19 行。最終行 2026-10-22T12:06:43Z `pass`（途中は next-action-gate / handoff-regret-gate / user-burden-gate 等で block、sameTextRetries 1 → 0 で通過）
- 677e8433: 4 行。最終行 2026-10-22T11:48:34Z `pass`（NEXT-ACTION-FOOTER / PERMANENT-FIX-REQUIRED で block 後に通過）

検出器の語彙 grep（`採否|承認.{0,4}却下`）: `decision-research-gate.mjs` / `deferral-wait-gate.mjs` / `permanent-fix-deferral-scan.mjs` / `next-action-gate.mjs` すべて 0 件。

判定: 欠陥あり。Stop gate は当該文面を最終的に通し、夜間監査（18:00Z）が事後に block と判定した。検出器が「採否を user の返信に委ねて停止」を直接拾えていない。

## §4 修正（C4）

codex-do へ3回委譲（指示ファイルは `.loop/quota-sweep-claude-c4*-instruction.md`、結果は同 `c4*-result.txt`）。最終 diff は `tools/deferral-wait-gate.mjs`（+31/−6）と `tools/deferral-wait-gate.test.mjs`（+9/−1）のみ。

1. **c4（前セッション）**: Codex usage limit を検出し codex-do が deepseek へ自動フォールバック。`DECISION_DEFERRAL`（`「?承認」?(?:か|または|もしくは)「?却下`・`(?:返事|返信)が来るまで(?:は)?(?:何も|着手|実行)`・`採否を?(?:user|ユーザー|kim|あなた)?の?(?:返信|返事)`）と `DECISION_DEFERRAL_REASON`、テスト陽性2件（§1 原文）＋陰性2件（audit引用行・「承認済みなので実行しました」）を追加。ただし `inAuditQuote` の書き換えで **無限ループ**を混入（`open===0` かつ本文が「」で始まるとき `lastIndexOf('「',-1)` が 0 にクランプされ open が減らない。`node -e "console.log('「ab'.lastIndexOf('「',-1))"` → 0 で機構を確認）。`node --test` が 120 秒以上完了せず、`--test-timeout` も同期ブロックで発火しない。
2. **c4b（2026-10-23、executor=codex）**: 当該 for 文を `open===0` で break する while に丸ごと置換（判定の意味は不変）。diff 範囲を監督が読み戻し、inAuditQuote 以外の差分がないことを確認。
3. **c4c（同、executor=codex）**: positives の共通 reason アサーションが旧語彙のみ期待していた（指示側の潜在的衝突）ため、`/当ターン内に完了まで進め|推奨案を採用して当ターン内で実行/` に置換（1行）。

検証（監督実測、委譲先報告に依らない）: `node --test tools/deferral-wait-gate.test.mjs` → **tests 52 / pass 52 / fail 0 / exit 0**（既存テストの削除・skip なし。52 = 旧48 + 新4）。

## §5 残件

- ~~C4 修正委譲、C6、C5 の結論更新~~ → 2026-10-23 実施（§4）。C6 は `node --test tools/` が Node v24.18.0 で `Cannot find module …	ools`（ディレクトリ引数不可）のため、等価の `node --test "tools/**/*.test.mjs"` で実施。2回実測:
  - **1回目（09:19）exit 1**（6235 tests / fail 12）。うち11件は fleet-mail の `--answer` 系テストで、実行セッションの環境変数（CLAUDE_HEADLESS=1 / ORGIAST_HEADLESS_JOB）が fleet-mail.mjs:1157 の判断代行拒否（return 2）を発火させたもの。**HEAD 977b59d のクリーン worktree でも同一失敗（F2×3・G3×3・G9×2 等）を再現** → 本修正と無関係の環境干渉。
  - **2回目（環境変数を外した検証用再実行）**: 当該11件は全て解消（6235 tests / 6226 pass / fail 1）。残る1件は distribution-coverage「リポジトリ直下の全項目が dirs/files/notDistributed のどれかに分類されている」で、未追跡の `.loop/` が未分類だったため。`.loop/` はループシステム自身が「ローカル状態でコミット対象外」（tools/quota-sweep.mjs:32、docs/quota-sweep.md:39）と設計しているので `.gitignore` に `.loop/` を追記して修正。追記後の targeted 再実行（distribution-coverage + fleet-mail-v2）で **150/150 pass**。
- `inAuditQuote` は開き括弧を本文先頭まで遡るため、audit 引用行より後の行にある本来の検出対象文を過剰除外し得る。現行テスト範囲では影響なし。将来の同型再発がこの経路で漏れたら bracket の閉じ判定を戻す。
- 窓が狭いため、時間が経った後の再走査で再発なしを確認する。
- upstream（origin/main）の .gitignore にも `.loop/` が無く、quota-sweep.mjs が worktree 作成時に .gitignore へ書き込まないため、ループ作業先では必ず distribution-coverage が落ちる。根本直し（worktree 作成時の自動追記）は別変更として残す。

## §6 再走査と最終受け入れ（2026-10-23 quota-sweep 再実行）

- 修正 e9e65f7 を本ブランチへ cherry-pick（c324e08。前回ブランチは未マージだった）。`node --test tools/deferral-wait-gate.test.mjs` → 52/52 pass。
- C2 再走査（窓 2026-10-22T18:00Z 〜 実行時点）: stop-gate 1014（窓 7）/ audit 876（窓 87）/ nightly 167（窓 3）/ deferral 38（窓 1）。語彙ヒットは引用 3 行（966ac0df・ae73200c＝本検証自身の文面）と原文 2 行のみ。逐語再発 0・同型再発 0。`permanent-fix-deferral-scan.mjs --since` は P1〜P4/W すべて 0。
- C6: `env -u CLAUDE_HEADLESS -u ORGIAST_HEADLESS_JOB -u ORGIAST_HOME node --test "tools/**/*.test.mjs"` → **exit 0**（6238 tests / 6230 pass / fail 0）。ORGIAST_HOME が設定された環境では ai-news-inject.test の5件が失敗する（コードが HOME より ORGIAST_HOME を優先するがテストは HOME のみ設定）。本修正と無関係の環境干渉で、今回は環境変数を外して実測した。
