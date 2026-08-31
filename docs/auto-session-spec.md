# 仕様: tools/auto-session.mjs（無人セッション runner）

kim 決定 2026-08-26: 「/session-start を毎回打つのが手間。自動でセッションを立ち上げて残作業を進めてほしい」
自律範囲 = **main マージ・デプロイまで全部（CI green を条件に）**。起動契機 = **夜間自動 + 手動1コマンドの両方**。

## 作るもの（3ファイル）

1. `tools/auto-session.mjs` — 本体
2. `tools/auto-session.test.mjs` — `node --test` で回る単体テスト（純関数を export してテストする）
3. `tools/register-auto-session.ps1` — スケジュールタスク `OrgiastAutoSession` を毎日 03:20 で登録（NightlyBatch 03:00 の後ろ）

## 動作フロー

1. `~/.claude/next-session.md` を読む（`ORGIAST_HOME` があればそちらの `.claude`）。これとは独立して、`tools/feedback-to-issues.mjs` と共有するリポジトリ表（定数 + `FEEDBACK_REPO_MAP`）から、`feedback` ラベル付きの open Issue も取得する。
2. **先頭の引き継ぎブロックだけ**を対象にする。ファイルは歴代ブロックの追記で 159KB あり、`<!-- NEXT-SESSION v1 -->` で区切られている。2本目以降は無視する。
3. 先頭ブロックから `## 残TODO` セクションの番号付き項目を抽出する。次は**除外**:
   - `~~` で囲まれた取り消し線（完了済み）
   - `要判断` / `判断待ち` / `未決` を含む行（kim の判断が要る）
   - `ブロック中` を含む行
4. 残った先頭から `--count N`（既定 1）件を選ぶ。フォーム報告は `in-progress` ラベル付きを除外し、独立した `--feedback-count N`（既定 1、最大 3）で選ぶ。全体として両入力源を混ぜず、それぞれの上限を適用する。
5. 各 TODO について子セッションを 1 つ起動する（下記「子セッションの起動」）。
6. 実行結果を `~/.claude/auto-session/runs/<YYYY-MM-DD>-<n>.json` に保存する（`claude.exe --output-format json` の出力をそのまま + 選んだ TODO 文 + 開始終了時刻 + exitCode）。
7. 全件終わったら Discord に 1 メッセージで要約を送る（下記「通知」）。

### フォーム報告 Issue の扱い（2026-08-28 kim 決定）

- 各対象リポジトリで `gh issue list --label feedback --state open` を使う。`gh` が無い環境ではフォーム入力だけを0件とし、`next-session.md` 経路はそのまま動かす。
- 着手時に `in-progress` ラベルを作成・付与する。子セッションの起動自体に失敗した場合だけ外して再試行可能にする。
- フォーム報告用には専用プロンプトを使う。Issue の番号・タイトル・本文・リポジトリを渡し、原因特定、修正、テスト・型チェック・ビルド、main からの新規ブランチ、`Closes #N` 付き PR 作成まで行う。
- **フォーム報告由来は PR で止める。PR をマージしない、本番へデプロイしない、main へ直接 push しない。承認は kim が行う。** `next-session.md` 由来の main マージ・デプロイまでの自律範囲は変更しない。
- 内容が曖昧なら推測で実装せず、不足情報を Issue にコメントして終了する。
- 完了後は `FEEDBACK_RELAY_URL` の `/api/feedback-intake` を `/api/notify` に置換し、同じ `FEEDBACK_RELAY_SECRET` で PR URL・タイトル・CI結果を通知する。PR を作れない場合も試行数と失敗数を通知し、中継未設定はログを1行出してスキップする。

## 子セッションの起動

- 実行ファイルの解決順:
  1. `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-*-win32-x64\resources\native-binary\claude.exe` を glob し、
     ディレクトリ名の `2.1.245` 部分を**数値でセグメント比較**して最大のものを選ぶ（文字列ソートだと 2.1.9 > 2.1.245 になるので不可）
  2. 無ければ PATH 上の `claude`
  - **バージョンを固定してハードコードしない**（拡張は自動更新される。固定するとある日黙って動かなくなる）
- 起動コマンド:
  ```
  claude.exe -p <prompt> --output-format json --model opus --permission-mode acceptEdits --add-dir <各作業ディレクトリ>
  ```
  - `.exe` なので `execFile` 相当で直接起動してよい（`.cmd` ではないので shell:true は不要）
  - プロンプトは**引数ではなく stdin で渡す**。日本語の長文を Windows の argv に乗せると文字化けとサイズ上限で壊れる。
    `-p` に空文字を渡して stdin から流す形にする。stdin 経路が使えない場合はテンポラリファイルに書いて
    「このファイルを読んで作業せよ」と短い引数を渡す方式にフォールバックする。
  - 環境変数 `CLAUDE_HEADLESS=1` を付ける。
  - `cwd` は TODO 本文からリポジトリを推定する。判定表（部分一致・上から順）:
    | TODO 内のキーワード | cwd |
    |---|---|
    | `ブース制作` | `C:\Users\uers\Downloads\ブース制作アプリ` |
    | `aujust` | `C:\Users\uers\Downloads\aujust-sales-automation` |
    | それ以外 | `C:\Users\uers\Downloads\orgiast-claude-rules` |
    - 実在しないパスは `orgiast-claude-rules` にフォールバックする
- タイムアウト既定 **45分**（`--timeout-min`）。超えたらプロセスツリーごと kill し、その run を `timeout` として記録して次の TODO へ進む。

## 子セッションに渡すプロンプト（buildPrompt）

次を順に連結する:

1. `あなたは無人で起動された自動セッションです。人間は見ていません。質問せず、完了まで自分で進めてください。`
2. `## 目的` + 選んだ TODO の本文（原文のまま。ID を要約したり言い換えたりしない）
3. 引き継ぎブロックの `## 対象` / `## 完了条件` / `## 触る前に読む memory` セクションがあればそのまま添付
4. 固定の作業規約:
   - 実装本体は `node tools/codex-do.mjs "<指示>" --cwd <path>` で Codex に委譲する（§1.18）。監督は設計・レビュー・検証だけ。
   - **他セッションと作業ツリーを共有している**。`git add -A` / `git commit -a` / `git stash` / `git checkout -- .` は**禁止**。
     自分が作成・変更したファイルだけをパス指定で `git add` する。着手前に `git status --porcelain` を撮り、
     コミット直前にもう一度撮って**差分が自分の変更だけであること**を確認する。
   - ブランチは必ず `main` から切る（積み上げ PR は main に届かない）。ブランチ名 `auto/<yyyymmdd>-<短いスラグ>`。
   - `node --test tools/*.test.mjs` が緑になるまで直す（ディレクトリ指定は落ちるのでグロブで）。
   - PR を作り、**CI が green になったのを確認してから** `gh pr merge --squash` でマージする。
     CI が赤なら直す。3回直して赤のままなら**マージせず PR を残して**理由を書いて終了する。
   - マージ後、変更が実際に効いているかを実物で検証する（デプロイ物なら実叩き、配布物なら raw URL を curl して grep）。
     検証できていないものを「完了」と書かない。
   - 作業が終わったら `~/.claude/next-session.md` の**先頭ブロックの該当 TODO 行だけ**を `~~…~~ → ✅ <日付> 完了（PR #N）` に書き換える。
     **ファイル全体を上書きしない**（並行セッションが同時に触っている）。行単位の置換で行う。
   - 秘匿値（APIキー・webhook URL・共有シークレット）を出力に書かない。
   - 外部への送信（メール送信・Discord への社外向け投稿・SNS 投稿・顧客への連絡）は**やらない**。人が起きている時に回す。
5. `## 完了報告` — 最後に 3 行以内で「やったこと / 検証したこと / 残ったこと」を出力する。

## ガードレール（必須）

- **ロック**: `~/.claude/auto-session/.lock` に `{pid, startedAt, todo}` を書く。既存ロックがあり、その PID が生きていて
  かつ 6 時間以内なら**起動を中止**する（多重起動で並行セッションが増えるのを防ぐ。実測でこの PC は同時 20 セッションまで膨れた）。
  死んだ PID / 6時間超のロックは stale として奪ってよい。終了時（異常終了含む）に必ず消す。
- **キルスイッチ**: `~/.claude/auto-session/disabled` が存在したら何もせず終了（exit 0・理由を出力）。
- **1回あたりの上限**: `--count` 既定 1、最大 3。夜間タスクも既定 1。
- **--dry**: 選んだ TODO と生成したプロンプトを表示して終了。子セッションは起動しない。
- **--list**: 抽出した TODO とフォーム報告 Issue の一覧（`[next-session]` / `[feedback]`、採用/除外と理由）を表示して終了。

## 通知

- `~/.claude/*.env` 系から Discord webhook を探して POST する。既存ツールが webhook を読む仕組みを持っていれば**それを再利用**し、
  新しい読み方を発明しない。見つからなければ標準出力に出すだけで正常終了する（通知失敗で run を失敗扱いにしない）。
- 本文: 日付 / 実行した TODO 見出し / 成功・失敗・タイムアウト / PR 番号があれば PR 番号 / 所要時間。
- **秘匿値をログにも通知にも書かない**。

## テストで押さえる純関数（export する）

- `parseHandoff(md)` → `{ block, todos, sections }`。先頭ブロックだけを返すこと、2本目以降を無視することをテストする。
- `filterTodos(todos)` → 取り消し線・要判断・ブロック中を除外することをテストする（それぞれ 1 ケース以上）。
- `pickCwd(todoText)` → 判定表どおりに返すこと。実在しないパスのフォールバックもテストする。
- `resolveClaudeExe(entries)` → バージョン比較が数値セグメント比較であること（`2.1.9` より `2.1.245` が新しいと判定されること）をテストする。
- `decideRun({ lockExists, lockPid, lockAgeMs, pidAlive, disabled })` → 起動可否の判定。stale lock 奪取・生きたロックで中止・killswitch をテストする。
- `markTodoDone(md, todoText, note)` → **先頭ブロックの該当行だけ**が書き換わり、他ブロック・他行が 1 バイトも変わらないことをテストする。

テストは `ORGIAST_HOME` をテンポラリに向けて実機の `~/.claude` を汚さないこと。

## やらないこと

- `claude.exe` のバージョン固定
- `~/.claude/next-session.md` の全文書き換え
- 他セッションの未コミット変更の巻き込みコミット
- 通知やログへの秘匿値の出力
