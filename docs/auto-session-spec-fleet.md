# 仕様追記: auto-session を全アカウント・全PCで動かす

kim 指示 2026-08-26「これを全アカウントで別のパソコンでも実行されるようにして」。

現状 `tools/auto-session.mjs` は **kim のユーザー名とパスを固定**しているので他PCで動かない。
機種非依存にし、`install-orgiast.ps1` の配布経路に載せる。

各PCは**自分の `~/.claude/next-session.md` の残TODO** だけを消化する（他人の作業を掴まない）。
その機体に `next-session.md` が無い / 採用できるTODOが無ければ**何もせず exit 0**（既存挙動）。

## 1. ハードコードを外す

### 1-1. リポジトリのルート
`DEFAULT_REPO = String.raw`C:\Users\uers\Downloads\orgiast-claude-rules`` を削除し、
**自分自身の位置から求める**: `path.resolve(import.meta.dirname, '..')`。
`tools/auto-session.mjs` は必ずクローン内に置かれるので、これがその機体のクローンになる。

### 1-2. 案件キーワード → リポジトリの対応表
`CWD_RULES`（`ブース制作` / `aujust` の絶対パス）はコードから削除し、
**任意の設定ファイル** `<home>/.claude/auto-session.json` から読む:

```json
{
  "historyCwd": "c:\\Users\\uers\\Downloads\\CLAUDE.md配布",
  "repoByKeyword": {
    "ブース制作": "C:\\Users\\uers\\Downloads\\ブース制作アプリ",
    "aujust": "C:\\Users\\uers\\Downloads\\aujust-sales-automation"
  }
}
```

- 設定が無い / 壊れている場合は**空の対応表**として扱い、全TODOがリポジトリルートで走る（他PCの正しい既定）。
- `historyCwd` が書かれていればそれを最優先で使う（自動検出より優先）。
- `export function loadConfig(homeDir, readFile = fs.readFileSync)` として純関数化しテストする。
- `pickCwd(todoText, exists, rules)` に対応表を引数で渡せるようにする。

### 1-3. 履歴を出すフォルダ（historyCwd）の自動検出
`HISTORY_CWD` の固定を削除し `export function detectHistoryCwd({ projectsDir, listDirs, newestTranscript, readCwd, exists })` を作る。
依存は全部注入可能にしてテストする。手順:

1. `<home>/.claude/projects/` の**バケット（サブディレクトリ）**を、中の `.jsonl` の最新 mtime 順に並べる。
2. 最も新しいバケットの、最新 `.jsonl` から `"cwd":"…"` を1つ取り出す（JSON 全体を parse せず正規表現で拾う。
   JSON 文字列なのでバックスラッシュは `\\` にエスケープされている → アンエスケープすること）。
3. **重要**: バケット名は「起動時に渡した cwd 文字列」をスラッグ化したもので、
   transcript の `cwd` フィールドは**ドライブレターが大文字に正規化されて**記録される。
   実測（2026-08-26）: 起動 cwd `c:\Users\uers\Downloads\CLAUDE.md配布` → バケット `c--Users-uers-Downloads-CLAUDE-md--`、
   一方 transcript の `cwd` は `C:\Users\uers\Downloads\CLAUDE.md配布`。
   **そのまま使うと別バケット（`C--…`）に分かれて履歴が2つに割れる**。
   よって `slug(cwd)` がバケット名と一致しない場合は**先頭1文字の大小を反転**して再照合し、一致した方を採用する。
   どちらも一致しなければそのバケットは捨てて次の候補へ。
4. 採用した path が実在しなければ次の候補バケットへ。全滅ならリポジトリルートを返す。
5. Windows 以外（ドライブレターが無い）では 3 の反転は no-op になること。

### 1-4. claude 実行ファイルの解決を全OS対応にする
- 環境変数 `CLAUDE_CLI` が設定されていればそれを最優先（PATH に入れられない環境の逃げ道）。
- `<home>/.vscode/extensions/` の `anthropic.claude-code-*` ディレクトリを走査し、
  `resources/native-binary/claude.exe`（win32）/ `resources/native-binary/claude`（それ以外）を候補にする。
  **プラットフォーム接尾辞（`-win32-x64` / `-darwin-arm64` 等）を決め打ちしない**。
- バージョン抽出の正規表現も接尾辞に依存しないこと（`anthropic.claude-code-<ver>` の `<ver>` を取る）。
- 見つからなければ `claude`（PATH）。
- 既存の「数値セグメント比較」は維持する（`2.1.9 < 2.1.245`）。

## 2. 配布（install-orgiast.ps1）

`OrgiastFleetPoller`（03:15）のブロックの直後に、同じ書き方で `OrgiastAutoSession`（**毎日 03:20**）を追加する。
既存2ブロックと同じ体裁を守る（`Step` / `OK` / `Warn`、`Test-Path` で無ければ Warn してスキップ、
`try/catch` で失敗しても他機能を止めない）。

- 登録は既存の `tools\register-auto-session.ps1` を呼ぶ形にして**登録ロジックを二重に書かない**。
- 日本語メッセージは既存ブロックと同じ調子で書く（何を・いつ・なぜが1行で分かること）。
- 失敗しても `exit` しない。

## 3. ONBOARDING.md

`### 2.8.1` の夜間バッチ原則の直後に `### 2.8.3 残TODOの無人消化（auto-session）` を新設し、次を1行ずつ書く:

- 各PCが**自分の `~/.claude/next-session.md` の残TODO**を毎日 03:20 に1件だけ無人消化する
- 除外: 取り消し線 / 判断待ち・未決 / ブロック中 / 他セッションが着手中 / 未来日ゲート（`YYYY-MM-DD 以降`）
- 止め方: `~/.claude/auto-session/disabled` という空ファイルを作る
- 手動実行: `tools\auto-session.cmd` をダブルクリック（`--list` で採用/除外だけ確認できる）
- 履歴は VSCode の `/resume` に出る。ログは `~/.claude/auto-session/runs/`、Discord 通知に
  transcript パスと `claude --resume <ID>` が入る
- `--permission-mode` は**渡さない**（`acceptEdits` は Bash を承認待ちで止める。既定の `auto` を継承する）

## 4. テスト（tools/auto-session.test.mjs に追加）

- `loadConfig`: 無い / 壊れている / 正常の3ケース。壊れていても throw しないこと。
- `pickCwd`: 対応表を引数で渡して分岐すること。空の対応表ならリポジトリルートを返すこと。
- `detectHistoryCwd`:
  - バケット名とスラッグが一致するケース
  - **ドライブレターの大小だけ違うケースで反転して一致させること**（1-3 の実測ケース）
  - 候補が実在しないときに次の候補へ進むこと
  - 全滅時にリポジトリルートを返すこと
- `resolveClaudeExe`: `-darwin-arm64` 接尾辞のパスでもバージョンを抽出できること。`CLAUDE_CLI` 優先。
- 既存テスト（`--permission-mode` を含まない等）は壊さない。

## やらないこと

- ユーザー名・ドライブ・案件パスのハードコード
- プラットフォーム接尾辞の決め打ち
- 他PCの `next-session.md` を読む / 中央から作業を配る（各機体は自分の残作業だけ）
- `--dangerously-skip-permissions` の使用
