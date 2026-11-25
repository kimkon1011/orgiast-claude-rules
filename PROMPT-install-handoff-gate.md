# `tools/install-handoff-gate.mjs` を作る（全PCへ配れる冪等インストーラ）

`~/.claude/settings.json` への hook 登録と旧 hook のリネームを行うスクリプトを作る。
使い捨てのインラインスクリプトではなく、**全PCで実行できる冪等なインストーラ**にする
（既存 `tools/install-orgiast.ps1` と同じ立ち位置）。

**このタスクでは `tools/` 配下に .mjs とテストを作るだけ。`~/.claude` 配下は書き換えないこと**
（実行は人がレビューしてから行う）。`--apply` を付けずに実行したときは dry-run で、
何をするかだけ表示して1バイトも書かない。

## やること

### 1. `~/.claude/settings.json` の編集（`--apply` 時のみ）
- 編集前に `settings.json.bak-<YYYYMMDD-HHmmss>` を作る
- **Stop** hook から `manual-handoff-detector.ps1` を含むエントリを削除
- **Stop** hook に追加（未登録なら）:
  `node "C:\Users\uers\Downloads\orgiast-claude-rules\tools\handoff-quality-gate.mjs"`
- **SessionStart** hook に追加（未登録なら）:
  `node "C:\Users\uers\Downloads\orgiast-claude-rules\tools\rule-compliance-report.mjs"`
- 追加先は `matcher` が `*` のグループ（無ければ先頭のグループ）
- **他の hook 登録を1つも消さない・並び替えない。** 編集は上記3操作だけ。
- 書き込み後に read-back: ファイルを読み直して
  ①`JSON.parse` が通る ②`manual-handoff-detector.ps1` が消えている
  ③新2件が登録されている ④**hook の総数が「元の数 − 削除数 + 追加数」と一致する**
  を全部検査し、1つでも外れたらバックアップから復元して非0で終了する。

### 2. 旧 hook のリネーム（`--apply` 時のみ）
`~/.claude/hooks/manual-handoff-detector.ps1` →
`manual-handoff-detector.ps1.bak-20260828-superseded`
- 既にリネーム済みなら何もしない。**削除は絶対にしない。**
- リネーム先が既に存在する場合は上書きせずスキップして報告する。

### 3. 冪等性
2回実行しても同じ最終状態。2回目は「変更なし」と報告して終わる。

### 4. パスの扱い
- Windows。`path.join` を使う。ホームは `process.env.ORGIAST_HOME || os.homedir()`
- リポジトリのパスは**このスクリプト自身の位置から解決**する（`fileURLToPath(import.meta.url)` の
  2つ上）。`C:\Users\uers\Downloads\...` をハードコードしない
  （他PCではパスが違う。ただし settings.json に書き込む command 文字列は
  解決した絶対パスを埋める）
- settings.json に入れる command 文字列内のバックスラッシュは JSON エスケープを壊さないよう
  `JSON.stringify` 経由で組む（手で `\\` を数えない）

## テスト `tools/install-handoff-gate.test.mjs`
`node:test`。**本物の `~/.claude/settings.json` は絶対に触らない**。
`--home` オプションで対象ホームを差し替えられるようにして、`os.tmpdir()` 配下の
偽ホームでテストする。

1. dry-run では1バイトも書かない
2. `manual-handoff-detector.ps1` が削除され、新2件が追加される
3. **他の hook 登録が1件も減っていない**（総数の照合）
4. 2回目の実行で「変更なし」になる（冪等）
5. `settings.json` が壊れている（不正JSON）場合は何も書かずに非0で終了する
6. read-back 検査が失敗したらバックアップから復元される
   （検査を意図的に失敗させる注入テスト）
7. 旧 hook のリネーム先が既にある場合は上書きせずスキップ

## 検証（自分で実行して出力を貼る）
- `node --test tools/install-handoff-gate.test.mjs` が通る
- `node tools/install-handoff-gate.mjs` （--apply なし）を実行し、
  dry-run の出力を貼る。**実際の settings.json が変わっていないこと**を
  `git status` ではなく mtime またはハッシュで確認して報告する

## 触らないこと
17:49 以前に更新されている他ファイル（`line-digest.mjs` / `auto-session.mjs` /
`feedback-widget/*` / `.github/workflows/test.yml` 等）は別作業の未コミット変更。絶対に触らない。
`rule-compliance-loop.mjs` / `rules-registry.json` / `handoff-quality-gate.mjs` も
別タスクが同時に編集中なので触らない。
