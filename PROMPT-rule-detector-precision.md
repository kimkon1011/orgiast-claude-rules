# 検出器の精度検証を必須にする（ループが自分を信用してよい条件を作る）

`tools/rule-compliance-loop.mjs` は動いたが、実データで**5ルール全部が即 block 昇格**し、
中身は誤検知だらけだった。実測（`node tools/rule-compliance-loop.mjs --days 7 --dry-run`）:

| ルール | 遵守 | 違反 | すり抜け | 強制 | 実際 |
|---|---:|---:|---:|---|---|
| handoff-quality-only | 10879 | 27 | 0 | block | すり抜けは ledger 未生成で構造上0＝無意味 |
| id-with-name | 10884 | 22 | 0 | block | `C0034 / Japan IT Week 秋` は併記済みなのに違反判定＝誤検知 |
| verify-before-done | 10718 | 188 | 0 | block | `完了|反映しました` が粗すぎてクローズ報告を違反判定 |
| delegate-implementation | 10850 | 56 | 0 | block | assistant 本文の `Write|Edit|MultiEdit` という*単語*を見ている＝無意味 |
| no-fable5 | 10905 | 1 | 0 | block | これは妥当 |

**根本原因: 検出器の精度を測る仕組みが無いまま、絶対件数で強制昇格していた。**
「常時赤になる検査は、検査対象ではなく検査側を疑う」（memory `feedback_verify_must_measure_the_producers_model`）。

## 作業1: ラベル付き fixture と精度測定を導入する

### `tools/fixtures/rule-samples.jsonl`
1行 = `{ruleId, label: "violation"|"compliant", text, note}`。
**各ルールにつき violation 5件・compliant 10件以上**を、実際の transcript
（`~/.claude/projects/*/*.jsonl`）から抜き出して作る。捏造しない。
上の表に出ている誤検知例（`C0034 / Japan IT Week 秋` など）は必ず `compliant` として入れる。

### `tools/rule-detector-precision.mjs`
fixture に対して各ルールの検出器を回し、`precision` / `recall` / 誤検知一覧を出す。
`node tools/rule-detector-precision.mjs` で表を標準出力。

### `rules-registry.json` に精度の実測値と検証状態を持たせる
各ルールに追加:
```jsonc
"validation": {
  "fixtureCount": 0,          // fixture 件数（自動更新）
  "precision": null,          // 実測値（rule-detector-precision.mjs が書く）
  "minPrecision": 0.9,        // これ未満なら強制昇格を禁止
  "status": "unvalidated"     // unvalidated | validated
}
```

## 作業2: 未検証の検出器は絶対に block へ昇格させない（フェイルセーフ）

`rule-compliance-loop.mjs` の昇格ロジックを次に変える:
- `validation.status !== "validated"` または `precision < minPrecision` のルールは
  **`enforcement` を `off` に固定**し、レポートに `⚠️ 検出器未検証（精度 X%）` と出す。
  **どんなに違反件数が多くても block にしない。**
- `validated` かつ `precision >= minPrecision` のルールのみ、既存の閾値ロジックで warn→block 昇格。
- 「すり抜け1件で即block」は維持するが、**ledger にレコードが1件も無い場合は
  『すり抜け0件』と書かず『すり抜け: 計測不能（ledger 未生成）』**と出す。
  0 と「測れていない」を絶対に混同しない。

## 作業3: 検出器を作り直す（精度優先。取りこぼしより誤検知を嫌う）

- `verify-before-done`: 本文の語彙マッチをやめる。**同一セッション内の tool_use 履歴**を見て、
  「完了報告」の直前に Bash/テスト実行/検証系の tool_use が無い場合のみ違反にする。
  transcript の `assistant.content[].type === "tool_use"` を使う。
- `delegate-implementation`: 本文マッチをやめる。**tool_use の Write/Edit の入力サイズ合計**を見て、
  同一セッションで閾値超え かつ `codex-do.mjs` の Bash 呼び出しが無い場合のみ違反。
  （`cost-work-loop.mjs` が既に行ベースで測っているのでそのロジックを再利用する）
- `id-with-name`: 除外条件を「丸括弧」に限定せず、**ID の前後40字以内に
  日本語2文字以上または英大文字語が併記されていれば compliant**とする。
- `handoff-quality-only`: 検出は `handoff-quality-gate.mjs` の `hasHandoff` と
  **同一の関数を import して共有**する（生産側と検査側でモデルを共有する）。
  registry の `violation` に入っている自然文プレースホルダ
  `"手渡し語彙または番号付き依頼手順"` は正規表現ではないので、共有関数への参照に置き換える。
- `遵守` のカウントをやめる（全メッセージを遵守に数えると比率が無意味）。
  代わりに **`該当`（そのルールの検査対象になったメッセージ数）と `違反`** を出し、
  `違反率 = 違反 / 該当` を表示する。

## 作業4: gate の ledger の excerpt が常に空のバグ

`tools/handoff-quality-gate.mjs` の `main()`:
```js
excerpt: (result.text || '').slice(0, 200)
```
`runGate()` が返すオブジェクトは `text` を持たないので **excerpt が常に空**。
これだと §3-4 の「すり抜け事例から gate 修正案を生成する」が材料不足で機能しない。
`runGate` の戻り値に検査した assistant text を含めるか、`main()` 側で取得して詰める。
回帰テストを追加すること（ledger に excerpt が非空で書かれる）。

## 厳守
- **`~/.claude/rule-enforcement.json` を書かない。** `--dry-run` なしでも、
  このタスクでは本番 enforcement を書かないこと（人がレビューしてから初回有効化する）。
- `~/.claude` 配下（CLAUDE.md / settings.json / hooks）は触らない（別途こちらで適用する）。
- 17:49 以前に更新されている他のファイル（`line-digest.mjs` / `auto-session.mjs` /
  `feedback-widget/*` / `.github/workflows/test.yml` 等）は**別作業の未コミット変更なので絶対に触らない**。
- Windows / ESM(.mjs) / UTF-8 BOMなし。

## 検証（自分で実行して出力を貼る）
1. `node --test tools/` が通る
2. `node tools/rule-detector-precision.mjs` の表（ルールごとの precision / 誤検知件数）
3. `node tools/rule-compliance-loop.mjs --days 7 --dry-run` の出力。
   **未検証ルールが `off` になっていること、`すり抜け: 計測不能` と出ることを確認する**
