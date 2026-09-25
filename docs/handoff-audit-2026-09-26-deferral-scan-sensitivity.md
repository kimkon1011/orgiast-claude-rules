# handoff-audit 再発検証: 「恒久修正を設計のみで次セッションへ送る」（2026-09-26）

対象: `[handoff-audit:8e5bf9c4366126ee]`
id は `sha256(JSON.stringify([NFKC(pattern), NFKC(route)])).slice(0,16)` で再計算し一致を確認済み。
出典: `handoff-audit-knowledge.json` の `source: handoff-audit-nightly:13755f2b…`。

読み取り専用の検証＋ツール1本の改修。送信なし・価格変更なし・kim への DM なし。

## 1. 実物の出典（未レビューの route ではなく台帳の生ログ）

`~/.claude/handoff-audit-nightly-ledger.jsonl`
`2026-09-25T18:02:29.322Z` / sessionId `3c012482-9a28-4212-9fe2-3d49c1d3f190` / verdict `block` / rules 3,2,11。

violation quote（原文）:
- `やりますか。これは配布の挙動を変えるので、勝手には進めません。`
- `次に kim がすること: ` + バッククォート + `task:nightly` + ` に自動修復を付けてよいかの可否。Codex のサインインも未実施のままです。`

（全文は本セッションで逐語確認。route 文言の「fork 制約」「マージ待ち」等は本件の実違反文には現れない。）

## 2. 再発の実測

- `tools/permanent-fix-deferral-scan.mjs` の P1/P2（字面の先送り表現）は
  **stop-gate 0/704・audit 0/496・nightly 0/166**。2026-09-25T18:05:18Z 以降の新規 block にも本型は無い
  （stop-gate の block 3 件は「Airbnb の未伝播の切り分け」等、いずれも `次に kim がすること: なし`）。
- **ただしこの「0件」は陰性の証拠にならない。** 唯一の既知真陽性（上記 §1 の2文）に対し、
  修正前の検出器は P1=false / P2=false ＝ **感度 0/1**。PR #572 の「有害形の再発は 0 件」も同じ検出器を根拠にしており、
  同じ盲点を共有していた。

## 3. 当該の先送り項目そのものは着地して動いている

09-25 の session は `task:nightly` への自動修復の可否を kim に投げていたが、恒久修正は既に実装済みだった。
- `tools/setup-manifest.json`: `task:nightly` に `"repair": ["register-stalled-session-nightly.mjs"]`
- `tools/stalled-session-resume.test.mjs` が同値を固定
- 実走の読み戻し: `~/.claude/logs/nightly-batch-2026-09-26.log` の
  `2026-09-26 03:19:47 / stalled-session-resume / ok`

＝「可否を仰ぐ」形を取ったが、実体として未実装だったわけではない。

## 4. 恒久修正（本 PR）

検出器に2パターンを追加し、感度を既知真陽性に合わせた。
- **P3（手渡し）**: `次に kim がすること:` の内容が `なし/ありません` で始まらず、かつ
  `実装|修正|改修|恒久|恒久化|修復|作り直` を含む。
- **P4（可否伺い）**: `やりますか|進めますか|進めてよいか|よろしいですか|可否|判断してください|決めてください|選んでください`
  かつ、その前後60文字以内に `恒久|配布|自動修復|実装|修正|改修|恒久化`。
- `detect(text)` / `PATTERNS` / 各 source の `byPattern` を追加（監査人が感度を書けるように）。
  W（完了待ち＝正規委譲待ち）は**先送りに数えない**ことをテストで固定した。

対照群（`tools/permanent-fix-deferral-scan.test.mjs`）:
- 真陽性: §1 の実違反2文 → P3 / P4 で検出。
- 真陰性: `次に kim がすること: なし` / `…ありません（…）` / `修正が完了しました` → `[]`。
- 分類: `Codex の2本の完了を待っています。` → `['W']`（待機であって先送りではない）。

修正後の実測（既知真陽性に対する感度）:
```
node tools/permanent-fix-deferral-scan.mjs --since 2026-09-25T18:00:00Z
handoff-audit-nightly-ledger.jsonl: hits=1 / 166
P1:0 P2:0 P3:0 P4:1 W:0
2026-09-25T18:02:29.322Z block 3c012482  …やりますか。これは配布の挙動を変えるので、勝手には進めません。…
```
＝ 0/1 → 1/1。

## 5. 未着手・未確認（断定しない）

- 本スキャナは nightly-batch / SessionStart に**配線されていない**（手で叩く計器）。自動で回る監査に載せるかは未決。
- パターン定義は §1 の1件に合わせた。同型の別表現（例: 判断を AskUserQuestion で投げる形）への感度は未測定。
- フルスイート: 無改変 720db0d の実測は fail 4 件（`booth-feedback-intake` / `long node eval warns` /
  `不具合の新規注入は detached launcher…` / `準備コマンド失敗時は stderr…`）。
  本 PR 適用後は同4件で、増減なし（作業中に `no-visible-console-window` を1件壊したが、
  新メソッド名 `exec(` が spawn と誤認されたためで、`find(` へ改名して解消済み）。
