# 強制を有効化できる状態にする（3つの欠陥を直してから enforcement を書く）

kim から「有効化して」の指示。ただし現状のまま `~/.claude/rule-enforcement.json` を
`block` で書くと**有害**なので、先に3件直す。

実測（`node tools/rule-compliance-loop.mjs --days 7 --dry-run`）:
```
| handoff-quality-only | 該当13 | 違反13 | 100.0% | すり抜け6 | block |
- 直近: 「両方の修正を流しました。見つかった欠陥を整理して報告します。…」  ← 手渡しではない
| id-with-name | 2 | 0 | 0.0% | 0 | warn |
| verify-before-done | 12 | 0 | 0.0% | 0 | warn |
| delegate-implementation | — | — | — | — | 担当: cost-work-loop.mjs |
| no-fable5 | 0 | 0 | — | 0 | warn |
```
`~/.claude/handoff-ledger.jsonl` は **4件しかない**（gate 設置が今日の途中だったため）。

## 欠陥1【最重要】`forceAll` が正当な手渡しまで塞ぐ

`tools/handoff-quality-gate.mjs`:
```js
if (enforcement['handoff-quality-only']?.mode === 'block' && enforcement['handoff-quality-only']?.forceAll)
  return { decision: 'block', reason: ... };
```
`forceAll` が立つと、**`[手渡し判定]` を正しく書いた品質理由のある手渡しまで無条件に block** される。
これはルールの趣旨（品質理由なら許す）に反する。実際 ledger には
「素の手渡しを block → 品質理由を書き直して pass」という正常動作の記録が残っており、
`forceAll` はその pass を潰してしまう。

修正: **`forceAll` の分岐を削除する。**
`enforcement` が `block` のときに強化するのは次だけにする:
- 要求する経路件数を `3` → `4` に引き上げる
- `未試行で却下した経路` に**2件以上**の記載を要求する
つまり「通れなくする」のではなく「**通る条件を厳しくする**」。
`enforcement` が `warn` のときは現行どおり（経路3件・却下1件以上）。
テストで「enforcement=block でも正しい[手渡し判定](経路4件+却下2件)は pass する」ことを固定する。

## 欠陥2 ledger 記録が無い応答を「すり抜け」に数えている

「gate が pass にしたのに監査で違反」= すり抜け、という定義なのに、
**ledger に記録が存在しない応答**（= gate がまだ動いていなかった時期の応答）まで
すり抜けに数えている。すり抜け6件はこれが原因（ledger は4件しかない）。

修正:
- すり抜けは **ledger に `verdict: "passed"` の記録が実在し、かつ監査で違反と判定された** ものだけ
- ledger に記録が無い違反は `計測不能` として**別カウント**にし、レポートに
  `違反 N件（うち ledger 記録なし M件=計測不能）` と出す
- すり抜けが計測不能ぶんで水増しされないので、「すり抜け1件で即block」が誤発火しなくなる
- テスト: ledger 4件・違反13件のとき すり抜けが 13 ではなく「ledger の passed と一致した件数」になる

## 欠陥3 gate/ルール自体を説明する応答を違反に数えている

違反13件の大半は、**gate の block 理由文を引用した応答**。
gate の理由文には「`[手渡し判定]` を書いてください。」が含まれ、その「してください」が
手渡し語彙として拾われている。ルールを直す作業をするたびに違反が積み上がる。

修正: `tools/rule-detectors.mjs` の `handoff-quality-only` 検出器に
**メタ言及の除外**を入れる（gate 側の `hasHandoff` と共有する形で実装し、
生産側と検査側でモデルを一致させる）:
- バックティック / 三連バックティックのコードブロック / 行頭 `>` の引用行 の内側の一致は無視
- 同じ行または前後1行に「gate」「hook」「検出器」「正規表現」「ルール」「block理由」「誤検知」
  のいずれかがある一致は無視
- **除外は「言及」だけに効かせる。** 本物の手渡し（手順+依頼語尾が引用でも
  コードブロックでもない地の文にある）は今まで通り違反にすること

修正後に `tools/fixtures/rule-samples.jsonl` に
**このセッションの実際の応答**（gate の理由文を引用した報告文＝手渡しではない）を
`compliant` として3件以上追加し、`node tools/rule-detector-precision.mjs` で
precision と recall を再測定する。

## 有効化（上の3件が終わって全テスト green になった後）

`tools/rule-compliance-loop.mjs` に `--apply` を追加する（既定は dry-run のまま）。
`--apply` 時のみ `~/.claude/rule-enforcement.json` に
`{ruleId: {mode, reason, since, precision}}` を書く。
- 書く前に既存ファイルがあればバックアップ
- 書いた後に read-back（JSON.parse / 全ルールが registry に存在する id か / mode が
  `off|warn|block` のいずれか）
- `validation.status !== "validated"` または `precision < minPrecision` のルールは
  必ず `off` で書く（既存のフェイルセーフを維持）

**このタスクでは `--apply` を実行しない。** 実装とテストと dry-run の報告まで。

## 厳守
- 既存の block 判定を弱めない。素の手渡し（品質理由なし / 経路不足 / 却下経路なし）は引き続き block
- `~/.claude` 配下（settings.json / CLAUDE.md / hooks / rule-enforcement.json）は書き換えない
- 他ファイル（`line-digest.mjs` / `auto-session.mjs` / `booth-feedback-intake.mjs` /
  `nightly-batch.ps1` / `feedback-widget/*` / `.github/workflows/*`）は別作業の未コミット変更。触らない
- `sms-kanri-2026/` 配下は別リポジトリ。触らない
- Windows / ESM(.mjs) / UTF-8 BOMなし。テストで `new URL(...).pathname` を使わない（`fileURLToPath` を使う）

## 検証（自分で実行して出力を貼る）
1. `node --test tools/` が全部green（30件以上、fail 0）
2. `node tools/rule-detector-precision.mjs` の表（precision / recall / 誤検知件数）
3. `node tools/rule-compliance-loop.mjs --days 7 --dry-run` の出力。
   **違反13件が減っていること、すり抜けが ledger 由来の件数になっていること**を示す
4. `node tools/rule-compliance-loop.mjs --days 7 --apply --dry-run` 相当で
   「書く予定の rule-enforcement.json の内容」を表示できること（実際には書かない）
