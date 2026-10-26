# handoff-audit:5dd97c87e35a632c 再発検証（2026-10-25）

## 対象

2026-10-23T07:23:14.553Z / session `9310953f` / P3 の先送り文:

> ITERATING 次に kim がすること: 修正 f94ee7a（ブランチ quota-sweep/20261023-0202-claude-mvkbryc

## 判定: **再発している。しかも既存の検出器が拾えていなかった。**

台帳を同じコマンドで再走査した結果、検出時刻以降に**同じ先送りが 11 行**あった（下記 §2）。
直近は **2026-10-24T04:36:20Z / session `61af55b9`**。

ただし先送りの**実体**（`f94ee7a` の main 着地）は **2026-10-23T15:44:33Z に PR #1047（`0449b88`）で
解消済み**で、当時すでに「着地待ち」ではなかった（下記 §3）。つまり再発した先送りは**実体の無い先送り**。

## 1. なぜ既存の検出器が拾えなかったか（実測）

`tools/permanent-fix-deferral-scan.mjs` の P3 は「次に kim がすること: <値>」の値に
`実装|修正|改修|恒久|恒久化|修復|作り直` が含まれるときだけ検出する。
ライブ側の `tools/next-action-gate.mjs` も `DEFERRAL_PATTERN = /(恒久策|恒久化|恒久的|次セッション|次回セッション|後日|先送り)/`
だけを見る。先送り文はどちらも「マージ／着地の**承認**を kim に求める」形で、FIX 語も先送り語も含まない:

```
次に kim がすること: `f94ee7a` を main にマージするか判断して承認する（承認が出るまでこのループは進まない）。
次に kim がすること: `f94ee7a`（ブランチ `quota-sweep/20261023-0202-claude-mvkbrycs`）を main に着地させるか承認してください。それまでは据え置きです。
```

∴ 「再発なし」と結論していた先行の再発検証（`docs/handoff-audit-2026-10-25-deferral-e2de84a9-recheck.md`）は
**検出器の死角を根拠にしていた**。台帳に行は残っていた（`stop-gate-runner-ledger.jsonl` の 10-24 04:34〜04:37）が、
P3 に一致しないので `hits=0` になっていた。

## 2. 再発走査（検出時刻 2026-10-23T07:23:15Z 以降・修正後の検出器で再走査）

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-23T07:23:15Z`

| 台帳 | 行数 | 修正前 hits | 修正後 hits |
|---|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 631 | 2（同一バーストの再送のみ） | **11** |
| `handoff-audit-ledger.jsonl` | 1480 | 0 | 0 |
| `handoff-audit-nightly-ledger.jsonl` | 45 | 0 | 3（いずれも 10-23） |

修正後に増えた分のセッション: `342a5479`（10-23T07:23:51〜07:24:01）・`8ea416ef`（10-24T04:34:09）・
`61af55b9`（10-24T04:36:20）。いずれも「`f94ee7a` を main にマージ／着地させるか承認してほしい」の同型。

補助走査: transcript（`~/.claude/projects` ほか 426 ファイル）からも同じ文型を検索し、
台帳に出ていない `61af55b9` の 4 ターン（04:34〜04:37）を確認した。

限界:
- 台帳・transcript に残った文だけが対象。それ以外の経路（チャット・口頭）は対象外。
- `なし（f94ee7a の main マージ承認は、次のループ周回で別途確認します）` のように
  「次に kim がすること: なし」で始めて括弧内に先送りを隠す形は `HANDOFF_EMPTY` の除外に当たり、
  引き続き検出しない（別の死角。今回は手を入れていない）。
- `PR #14 を確認（マージ判断のみ）` のような**確認**依頼は対象外に保った（既存テストの回帰を維持）。

## 3. 先送りの実体はもう無い（実物確認）

- `f94ee7a` 自体は origin/main の祖先ではない（squash 着地のため）。**同じ変更**が PR #1047（`0449b88`・
  2026-10-23T15:44:33Z）として main に入っている: `origin/main:tools/stop-gate-runner.mjs:135` の
  `audit.record.skipped === 'regex-blocked' && !evaluated.results.length` 再評価ブロック（f94ee7a の追加5行と同一）。
- 本番の Stop hook が実行する `~/.claude/nightly-repo/tools/stop-gate-runner.mjs` にも同ブロックがある
  （nightly-repo HEAD `95c0612`、main の子孫）。
- 実効性: 着地後（2026-10-23T15:44Z 以降）の `handoff-audit-ledger.jsonl` 112 行のうち、
  `fired=true` かつ `provider=deepseek` が 6 行（pass 3 / block 2 / audit-unavailable 1）＝
  再評価経路は本番で実際に provider 判定を返している。
- ∴ **kim の操作は不要。** 承認待ちとして残す理由は無い。

## 4. 恒久修正（このターン内に実装）

先送りの型は「FIX 語を含まない着地承認依頼」なので、検出器の側を広げた。

1. `tools/permanent-fix-deferral-scan.mjs`
   - `isLandingDeferral(value)` を追加し P3 から使う。条件は
     **着地語**（マージ/着地/取り込/merge）∧**具体的な識別子**（7桁以上の hex、または `/` を含む branch 風トークン）∧
     **承認要求**（承認/判断/決め/指示/ください/返す/据え置き/待ち）。
     識別子を条件にしたのは `PR #14 を確認（マージ判断のみ）`（確認依頼）を巻き込まないため。
2. `tools/next-action-gate.mjs`
   - 同じ判定をライブの Stop ゲートにも配線（`isLandingDeferral(footer.nextAction)`）。次回からは
     ターン終了時点で block し、その場で着地させるか「着地済み」を確認させる。
3. テスト: `tools/permanent-fix-deferral-scan.test.mjs` に正例 3・負例 4、
   `tools/next-action-gate.test.mjs` に live ゲートの正例/負例を追加。
   検証: `node --test tools/permanent-fix-deferral-scan.test.mjs tools/next-action-gate.test.mjs tools/stop-gate-runner.test.mjs`
   = **154 tests / pass 154 / fail 0**。

## 5. 残っている死角（次の監査項目の候補・このターンでは未着手）

- `次に kim がすること: なし（…別ターンで承認します）` の形（`HANDOFF_EMPTY` の除外をすり抜ける）。
- `PR #1069 をマージしてよいか` のように **PR 番号だけ**を指す着地依頼（識別子条件が hex/branch のため対象外）。
  誤検出との線引きが要るので、実原文を集めてから条件を決める。
