# next-action-gate 本人手渡し待ち修正結果

## 変更ファイルと差分

- `tools/next-action-gate.mjs`: footer より前の本文に `[手渡し判定]`、`お願いする操作`、行頭 `手間監査:` があれば本人手渡しと判定。nextAction が「なし」でも既存の人待ちチェックへ合流させ、同一セッションの open 台帳行または理由付き `[NO-AUTOCHECK-OK: 理由]` を要求する。本人手渡しの場合だけ既存 reason の先頭に指定文を追加。
- `test/next-action-gate-user-wait.test.mjs`: 回帰テスト7件追加。既存テストは `tools/next-action-gate.test.mjs` にあるため、指定された `test/` には新規作成。既存と同じ `ORGIAST_HOME` 注入点で一時台帳を使い、終了時に環境変数復元・削除する。
- `result-next-action-gate-user-wait.md`: 本結果ファイル。

## 既存挙動の維持

既存の nextAction 判定を OR 条件の片側としてそのまま残し、`!permanentFix`、`classifyHandoff(source) !== 'reply-only'`、`hasOpenSessionCheck(input)`、理由付き例外の条件は変更していない。マーカーなしの reason も同一。台帳読み込み関数の変更はない。
既存75件が全件 pass（恒久策、人待ち、台帳、例外、返信のみ、footer、期限等）。新規7件も全件 pass。hook・gate・permissions の解除や緩和、commit / push / PR は行っていない。

## テスト実行結果

この環境の `node --test` の出力はファイル単位（各1 pass / 0 fail）だったため、個別ケースの件数も確認できるよう同じファイルを直接実行し、新規7 pass / 0 fail、既存75 pass / 0 fail を確認した。以下は実際の出力（直接実行分は集計部分）。

### `node --test test/next-action-gate*.test.mjs`

```text
TAP version 13
# Subtest: test/next-action-gate-user-wait.test.mjs
ok 1 - test/next-action-gate-user-wait.test.mjs
  ---
  duration_ms: 747.345465
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 856.936328
```

### `node --test tools/next-action-gate.test.mjs`

```text
TAP version 13
# Subtest: tools/next-action-gate.test.mjs
ok 1 - tools/next-action-gate.test.mjs
  ---
  duration_ms: 866.660169
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 897.063897
```

### `node test/next-action-gate-user-wait.test.mjs`

```text
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 149.489654
```

### `node tools/next-action-gate.test.mjs`

```text
1..75
# tests 75
# suites 0
# pass 75
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 309.227531
```
