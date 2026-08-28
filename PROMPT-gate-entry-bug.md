# 【重大】gate が CLI 経由で無言で何もしない — 既知バグの再導入

## 実測
`rule-enforcement.json` を `handoff-quality-only: block` で書いた後、
経路3件（block基準は4件）の手渡しを gate に流したが **block されず、出力もログも無く exit 0**。

```
$ printf '{...経路3件...}' | node "C:\Users\uers\Downloads\orgiast-claude-rules\tools\handoff-quality-gate.mjs"
exit=0        ← 何も起きない
```

ところが `evaluateHandoff()` を直接呼ぶと正しく判定できている:
```
enforcement mode: block
decision: block | reason: 既知の自動化経路が3件です。4件以上必要です。
routesMatched: ["impersonate","Sheets API","DWD"]
```

**判定ロジックは正しい。`main()` が呼ばれていない。**

## 原因（このリポジトリに既に対策ヘルパがある既知バグ）
`tools/handoff-quality-gate.mjs` の最終行:
```js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
```

`tools/is-entry.mjs` のヘッダに、まさにこの問題が書かれている:
> 素の文字列比較(import.meta.url === argv[1])だと、Windows の ~/orgiast-claude-rules が
> Downloads へのジャンクションになっている環境で判定が外れ、CLI が無言で何もしない(実測 2026-08-19)

同じバグを再導入している。**強制機構が無言で何もしないのは最悪の故障モード**で、
「ルール化したのに実行されない」の直接原因になる。

## 修正

### 1. `isEntry` を使う
```js
import { isEntry } from './is-entry.mjs';
...
if (isEntry(import.meta.url)) await main();
```
`is-entry.mjs` は realpath 正規化と大文字小文字の差を吸収する。**素の文字列比較に戻さない。**

### 2. 同じ書き方が他の新規ファイルにも無いか点検して直す
`tools/rule-compliance-loop.mjs` / `tools/rule-detector-precision.mjs` /
`tools/rule-compliance-report.mjs` / `tools/install-handoff-gate.mjs` /
`tools/rule-detectors.mjs` の起動判定を全部確認し、
`process.argv[1]` の素の比較を使っているものは `isEntry` に置き換える。
（`rule-compliance-loop.mjs --apply` が無言で何もしなければ、強制の更新も静かに止まる）

### 3. 「無言で何もしない」を今後検知できるようにする
gate は **stdin を読んで JSON として解釈できたのに何も判定しなかった**場合、
stderr に `[handoff-quality-gate] 判定をスキップしました: <理由>` を出す。
「入力があったのに無反応」を沈黙させない。

## 回帰テスト（`tools/handoff-quality-gate.test.mjs` に追加。これが本命）
**`evaluateHandoff()` の単体テストでは今回のバグを検出できなかった。**
必ず**子プロセスとして CLI 起動**して検証すること（`spawnSync` + `input`）。

1. **CLI 起動で block が返る**: 経路2件の手渡しを stdin に流し、
   stdout に `decision: block` の JSON が出ること（＝`main()` が動いた証拠）
2. **`enforcement=block` のとき CLI で経路3件が block される**:
   一時ホーム（`ORGIAST_HOME`）に `rule-enforcement.json` を
   `{"handoff-quality-only":{"mode":"block"}}` で置き、経路3件を流して block されること
   **← 今回すり抜けた条件そのもの**
3. **`enforcement=block` のとき CLI で経路4件+却下2件は pass する**
4. **ジャンクション経路でも動く**: 可能なら `~/orgiast-claude-rules` 側の
   パスで CLI 起動しても同じ結果になることを検証する。
   ジャンクションが無い環境ではこのテストを skip する（`fs.existsSync` で判定し、
   **skip したことをテスト名に出す**。黙って通過させない）
5. 既存31テストが全部通り続ける

テストで `new URL(...).pathname` を使わない（Windowsで `/C:/...` になる）。`fileURLToPath` を使う。

## 厳守
- 判定ロジック（`evaluateHandoff`）は変えない。直すのは起動経路と診断出力とテスト
- 既存の block 判定を弱めない
- `~/.claude` 配下は書き換えない（`rule-enforcement.json` は既に書かれているので触らない）
- 他ファイル（`line-digest.mjs` / `auto-session.mjs` / `booth-feedback-intake.mjs` /
  `nightly-batch.ps1` / `feedback-widget/*` / `.github/workflows/*`）は別作業の未コミット変更。触らない
- `sms-kanri-2026/` 配下は別リポジトリ。触らない
- Windows / ESM(.mjs) / UTF-8 BOMなし

## 検証（自分で実行して出力を貼る）
1. `node --test tools/` が全部green（35件以上、fail 0）
2. 実際にコマンドを叩いた出力を貼る:
   - 経路3件 + `enforcement=block` → `decision: block` が stdout に出ること
   - 経路4件+却下2件 + `enforcement=block` → 出力なし（pass）
3. `node tools/rule-compliance-loop.mjs --days 7 --dry-run` が引き続き動くこと
