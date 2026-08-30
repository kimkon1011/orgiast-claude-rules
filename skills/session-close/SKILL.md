---
name: session-close
description: セッションを綺麗に閉じて次に引き継ぐ。「終わりにする」「一旦区切る」「今日はここまで」「セッション閉じる」「次に引き継いで」「クリアする前に」「まとめて終わって」などセッション終了・区切りの合図が来たら必ずこのスキルを使う。1セッション=1目的を守るため、タスクが1件完了した時点でも Claude 側から自発的に提案してよい。
---

# セッションを綺麗に閉じて次へ引き継ぐ

## 1. 成果を3行で要約

- このセッションで何を変えたかを3行で要約する。
- 長い引用やコード本体は載せない。

## 2. 未コミット差分の確認

- `git status --short` を実行する。
- 差分があれば commit → push → PR → **マージ**まで自分で行い、差分を放置して閉じない（2026-08-19 以降は自作PRのマージも Claude が行う。`gh pr checks` が全green・スコープ内・非破壊 を確認してから `gh pr merge --squash --delete-branch`）。

## 3. memory へ永続化

- 次回も効く恒久的な事実だけを `~/.claude/projects/<projectId>/memory/` に書く。
- 既存ファイルを先に探し、重複を作らず更新を優先する。書いたら同時に `MEMORY.md` の索引へ1行追加する。
- 会話固有の一時情報、コード構造、git 履歴が既に記録していることは書かない。

## 4. マキモノへ出品（再利用できる知見だけ・全自動）

- 判定: このセッションの成果に「他社・他人の環境でも再現できる汎用手順」が含まれるか。
  - 出品する: 新しい仕組みの作り方、hook/skill の型、外部API連携の手順、失敗パターンと回避策
  - 出品しない: 社内データの集計結果、単発の調査、特定顧客の案件対応、既に出品済みの内容
- 重複確認: `node ~/orgiast-claude-rules/tools/makimono-search.mjs "<テーマ>"` で同義の巻物が既にあれば出品しない（既存を更新したい時だけ kim に一言伝える）。
  `makimono-search.mjs` は**公開済みしか見ない**ので、審査待ち(pending)の同主題には当たらない。
  そちらは `--submit` 側が投稿ログと突き合わせて自動で止める（近い題名があると警告して exit 2。
  別主題だと確認できたときだけ `--force` を付けて再実行する）。出してからでは取り下げられない。
- MD をスクラッチパッドに書く（リポジトリにはコミットしない）。**一般化が絶対条件**: 社名・顧客名・個人名・メール・スプレッドシートID・Drive URL・webhook・ローカルの絶対パスは
  すべて一般名（`<自社ドメイン>` `<スプレッドシートID>` 等）に置き換え、「AI に読ませればそのまま動く」粒度で書く。
- トークン見積り: `scratchTokens`（ゼロから作らせた場合）と `withMdTokens`（この指示書を読ませた場合）をこのセッションの実績から見積もる。
- 出品（価格は常に 0 = 無料。kim の決定）:

  ```
  node ~/orgiast-claude-rules/tools/makimono-publish.mjs --submit --file <md> \
    --title "..." --summary "..." --category "<カテゴリ>" \
    --scratch-tokens N --with-md-tokens N --price 0
  ```

  - APIキーは初回に自動発行される（人間の作業はゼロ）。カテゴリ一覧は `makimono-search.mjs --categories`。
  - **exit 2 = 送信禁止スキャンに当たった**。一般化して書き直すか、汎用化できない内容なら出品を諦める。
    退避された下書きは `~/.claude/makimono-drafts/` にある。
- 出品は必ず審査キュー(pending)に入る。**出品して pending と報告して終わることは禁止**。出品後は必ず `node <repo>/tools/makimono-publish.mjs --check --notify` を実行する。
- 結果は `出品: <title> → pending (sub_xxx) / 未公開の滞留 M件` の形で滞留件数まで報告する。`--stale-days`（既定3日）超過があれば、その件数も kim への報告に1行入れる。
- 出品しなかった場合は「出品対象なし」と1行書く（黙って飛ばさない）。

## 5. 残TODO を列挙

- 「次セッションで最初にやる1件」を先頭にして残TODOを列挙する。
- ブロッカーがあれば理由も添える。

## 6. 引き継ぎを `~/.claude/next-session.md` に書き出す

- **画面に出すだけで終わらせない。** kim にコピペさせるのは手作業なので、必ずファイルへ書く。
  次セッションは `/session-start` がこのファイルを読んで再開する（[[session-start]] とペア）。
- 既存の `next-session.md` を先に読み、**まだ着手していない残TODO を消さずに引き継ぐ**（上書きで失わない）。
- 書式（この見出し構成を変えない。`/session-start` が読む）:

```markdown
<!-- NEXT-SESSION v1 -->
<!-- 前セッション: <sessionId> / 更新: <YYYY-MM-DD> / cwd: <作業ディレクトリ> -->

## 次の1目的
<1件のみ。決まっていなければ「未定」>

## 対象
<ファイルパス>

## 完了条件
<検証手段まで含めて>

## 直前セッションの成果（3行）
- …

## 残TODO（次の1件を先頭に）
1. …

## 触る前に読む memory
- [[…]]

## 未決（kim の判断待ち）
- …
```

- 書いたら「次のセッションは自動で立ち上がって `/session-start` から始まります」と1行で伝える（手順8 が自動でやる）。

## 7. セッションを一覧から自動で消す（`/clear` は不要）

- hook が出した `[session] このセッションのIDは …` の ID を使い、最後に次のコマンドを実行する。

```bash
node "$HOME/orgiast-claude-rules/tools/close-session.mjs" --session <このセッションのID>
```

- ID が分からない場合だけ引数なしで実行してよいが、並行セッションがある場合は誤退避を防ぐため安全に停止する。
- 45秒ほどで `_deleted-backup/_closed/` へ退避されて一覧から消える。`/clear` は不要。
- 実体は削除せず move するため復元できる。
- 積み残しは `/session-triage` で後から拾える。

## 8. 次のセッションは自動で立ち上がる（user に「新しいセッションを開いて」と言わない）

- 手順7 の `close-session.mjs` が、退避したあとに `tools/next-session-launch.mjs` を呼び、
  **新しいターミナルウィンドウで `claude "/session-start"` を argv 起動する**。プロンプトは argv なので
  そのまま送信され、user がセッションを開く手作業はゼロ（2026-08-30 に end-to-end 検証済み）。
- **VSCode の中に開く経路は使わない**（既定は `terminal`）。拡張の URI
  `vscode://Anthropic.claude-code/open?prompt=...` は**新しいタブを開くだけでプロンプトを送信しない**
  （拡張 2.1.251 の実体は `setInputText` のみ／実測では入力欄にも入らない）。VSCode CLI に `--command` も無く、
  Enter を代打ちする手も成立しない（入力欄が未フォーカス・Ctrl+Esc はスタートメニューと衝突・前面が別アプリだと
  他PCのリモート画面に Enter が入る）。VSCode 内にタブだけ開きたい時は `--target vscode`
  / `ORGIAST_NEXT_SESSION_TARGET=vscode`（その場合 user が入力欄で送信する1手が必ず残る）。
- 起動先の作業ディレクトリは `~/.claude/next-session.md` の `cwd:` コメント →
  `~/.claude/current-session.json` の cwd → リポジトリルート の順で決まる。だから**手順6 を先に書くこと**。
- CLI の trust ダイアログ（「このフォルダを信頼しますか」）は**起動前に自動で事前登録する**ので出ない
  （`~/.claude.json` の `projects[<cwd>].hasTrustDialogAccepted` を両表記で立てる。2026-08-30 に kim が
  「この件は今後自動で押してほしい」と明示の恒久承認を出した → [[feedback_auto_accept_local_consent_dialogs]]）。
  対象は**起動する cwd だけ**。止めたい時は `ORGIAST_NO_AUTO_TRUST=1`。
  なお `~/.claude.json` が読めなかった時は**触らない**（`{}` を土台に書き戻すと設定ごと消えるため）。
  この緩和は kim 自身のPCのローカル同意に限る。外部サービスの OAuth・支払い・共有範囲変更・他アカウントの
  安全機構解除は**引き続き人が判断する**。
- 抑止したい時（無人実行・連続クローズ）:
  - `node tools/close-session.mjs --session <id> --no-launch` … 起動しない
  - `CLAUDE_HEADLESS` / `CI` が立っている環境では自動で起動しない（夜間 auto-session でウィンドウを開かない）
  - 直近120秒に起動済みなら二重起動しない（`--force-launch` で無視できる）
  - 恒久的に止めるなら `~/.claude/next-session-launch.json` に `{"enabled": false}`
- 起動結果は `[next-session] 新しいセッションを起動しました: <cwd>` / `[next-session] スキップ: <理由>` の1行で出る。
  スキップされた時だけ「新しいセッションを手で開いてください」と伝える。

## 注意

- セッションファイル・Drive のファイルは絶対に削除しない（過去版が必要 / kim 厳命）。
- memory 書き込み前に必ず既存を検索し、重複を防ぐ。
- コスト実績を見たい時は `node ~/orgiast-claude-rules/tools/cost-work-loop.mjs`。
