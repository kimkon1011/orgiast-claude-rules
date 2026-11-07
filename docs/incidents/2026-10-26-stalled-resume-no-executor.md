# 2026-10-26 stalled-session-resume no-executor 事故

## 概要

2026-10-26 の夜間実行で、`stalled-session-resume` は session
`3827d002-ee95-4491-bf67-9f0149a5330e` と
`3ef4d6d1-cdd4-4e10-8bfd-cd1105da7338` を順に再開しようとした。実行役が起動できなかったにもかかわらず、旧実装は各セッションを `outcome=error`, `reason=failure` と記録し、連続2件エラーとしてその夜を中止した。

台帳の時刻では、1件目は 2026-10-25T18:01:25.710Z から 18:01:26.892Z まで約1.18秒、2件目は 18:01:26.897Z から 18:01:27.072Z まで約0.18秒だった。`nightly-batch.log` にも `stalled-session-resume exited 1` と `aborted: true` が残っている。

## 原因と旧挙動

直接原因は、DeepSeek レーンの `payment_required` などで `runChild()` が `skippedNoExecutor=true` を返した場合も、旧 `execute()` が通常の `status=failure` と同じ `error` に変換していたことだった。

そのため、実際にはセッションを実行していないのに、試行履歴、夜間件数、`noProgress`、連続エラー数を消費した。2件目で中止条件に達し、「連続2件エラーのため今晩は中止」というセッション由来ではない通知も生成した。

## 修正

PR #1152、コミット `19b2d5aaeb8a9cbebd77f988b7016bbf23ecad31` で修正済み。

- `skippedNoExecutor` を `outcome=no-executor` として通常の失敗から分離する。
- 起動前に仮計上した attempt、`noProgress`、夜間件数を戻す。
- 連続エラー数を増やさず、セッション再開の通知もしない。
- 同じ実行役不足が後続でも続くため、その夜の処理だけを打ち切る。
- 次回実行時には `noExecutor` 状態を消し、同じセッションを再試行可能にする。

現行 main の分岐順、台帳更新、通知条件を確認し、事故経路に対する追加修正は不要と判断した。既存コードと既存テストの期待値は変更していない。

## テスト

2026-10-28 に次を実行した。

```text
node --test tools/stalled-session-resume.test.mjs tools/auto-session.test.mjs
```

結果は 155 tests、153 pass、0 fail、2 skip。専用回帰テストは、実行役不足時にエラー・通知・試行予算を消費しないこと、同じ夜に実行役が復旧すれば再試行できること、および `payment_required` を `no-executor` に変換することを確認している。

## 実配布確認

`C:\Users\test\.claude\nightly-repo` の HEAD は確認時点で `70bbaf5f471ac380c659b1a42e0f9f611ecf8c41`。`git merge-base --is-ancestor 19b2d5a HEAD` は成功し、修正コミットを包含していた。

配布先の `tools/stalled-session-resume.mjs` と `tools/stalled-session-resume.test.mjs` は、監査した現行 main の同名ファイルとそれぞれ SHA-256 が一致した。したがって、修正コードと回帰テストは HP の実配布先にも存在する。

## 再検証方法

1. 上記2ファイルを指定した `node --test` を実行し、fail が0件であることを確認する。
2. `runChild()` が `{ status: "failure", skippedNoExecutor: true, stderr: "payment_required" }` を返すケースで、戻り値が `no-executor` になることを確認する。
3. 実行後の台帳で attempt、`noProgress`、夜間件数、連続エラー数が増えず、通知が送られないことを確認する。
4. 実配布先 HEAD が `19b2d5a` を包含し、配布先実装に `skippedNoExecutor` と `no-executor` の分岐があることを確認する。
