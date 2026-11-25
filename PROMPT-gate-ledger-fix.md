# テスト11/12が落ちる原因はWindowsパスバグ。加えて ledger の書き込み失敗が黙殺されている

`node --test tools/` は21件中19 pass / **2 fail**（`11 ledger excerptが非空` / `12 excerptが空なら警告してledgerを書かない`）。
`handoff-quality-gate.mjs` 本体のロジックは既に正しい。**落ちているのはテスト側のバグ**。

## 作業1【原因確定済み】テストのWindowsパスバグを直す

`tools/handoff-quality-gate.test.mjs` の11・12番:
```js
spawnSync(process.execPath, [new URL('./handoff-quality-gate.mjs', import.meta.url).pathname], ...)
```

`new URL(...).pathname` は Windows で **先頭にスラッシュが付いた `/C:/Users/uers/...`** を返す（実測済み）。
Node はこのパスのスクリプトを読めないため、プロセスが起動に失敗して
`p.status !== 0` になり assert が落ちる。gate の不具合ではない。

修正: `import { fileURLToPath } from 'node:url'` を使い
`fileURLToPath(new URL('./handoff-quality-gate.mjs', import.meta.url))` に変える。
**`.pathname` を使っている箇所が他のテストにもあれば全部直す**
（`install-handoff-gate.test.mjs` / `rule-compliance-loop.test.mjs` / `rule-detector-precision.test.mjs` も確認）。

## 作業2【重要】ledger の書き込み失敗を黙殺しない

`handoff-quality-gate.mjs` の `main()`:
```js
try { fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.appendFileSync(ledger, JSON.stringify(record) + '\n'); } catch {}
```

**`catch {}` で失敗を捨てている。** `handoff-ledger.jsonl` は
「gateが通した手渡しを後から監査してすり抜けを見つける」唯一の材料なので、
書けなかったことに誰も気づかないとループ全体が盲目になる（すり抜けが常に0件に見える）。

修正:
- 書き込みに失敗したら **stderr に理由付きで警告**を出す（`[handoff-quality-gate] ledger書き込み失敗: <理由> path=<パス>`）
- 書き込み失敗でも `decision: block` の出力は必ず行う（hook の判定機能を落とさない）
- **書き込み後に read-back**: 追記したファイルの最終行を読み直して
  `JSON.parse` でき `excerpt` が非空であることを確認する。外れたら stderr に警告
- テストを追加: 書き込み先を**書き込み不可な状態にして**（存在するファイルをディレクトリ名の位置に置く等）
  実行し、①stderr に警告が出る ②`decision: block` の出力は出る ③プロセスは exit 0 を返す
  ことを検証する

## 作業3 実際に ledger が書かれることを実測で確認する

`ORGIAST_HOME` に一時ディレクトリを指定して gate を1回叩き、
`<ORGIAST_HOME>/.claude/handoff-ledger.jsonl` に1行書かれ、
その行の `excerpt` が非空・`verdict` が `passed` になることを**実際にコマンドを叩いて出力を貼る**。
（先ほど手で叩いたときは ledger が生成されなかった。原因が ORGIAST_HOME の解釈なのか
書き込みエラーの黙殺なのかを、作業2の警告出力で切り分けて報告すること）

## 触らないこと
- `~/.claude` 配下（settings.json / CLAUDE.md / hooks）は書き換えない
- `~/.claude/rule-enforcement.json` を書かない
- `install-handoff-gate.mjs` を `--apply` で実行しない
- 17:49 以前に更新されている他ファイル（`line-digest.mjs` / `auto-session.mjs` /
  `feedback-widget/*` / `.github/workflows/test.yml` 等）は別作業の未コミット変更。絶対に触らない
- `sms-kanri-2026/` 配下は別リポジトリ。触らない

## 検証（自分で実行して出力を貼る）
1. `node --test tools/` が **全部green（fail 0）**
2. 作業3の実測出力（ledger の1行をそのまま貼る）
3. `node tools/rule-compliance-loop.mjs --days 7 --dry-run` が引き続き動き、
   ledger が存在する状態では「すり抜け」が**計測不能ではなく件数**で出ること
