---
name: session-start
description: 新しいセッションを前セッションの引き継ぎから開始する。「次の作業を始める」「続きから」「引き継いで始めて」「新しいセッションを始める」「/clear した後」などセッション開始・作業再開の合図が来たら必ずこのスキルを使う。前セッションが /session-close で書いた ~/.claude/next-session.md を起点に、目的を1件だけ確定してから着手する。
---

# 前セッションの引き継ぎから作業を開始する

「1セッション=1目的」を守るための入口。`/session-close` の出口とペアで使う。

## 1. 引き継ぎを読む

- `~/.claude/next-session.md` を読む。これが前セッションからの引き継ぎ（目的・対象・完了条件・残TODO・読むべき memory）。
- ファイルが無い / 「次の1目的: 未定」なら 手順2 で目的を確定する。
- `## 触る前に読む memory` に挙がっているファイルを実際に読む（`MEMORY.md` の索引ではなく本体）。**ここを飛ばすと前セッションの失敗を繰り返す。**
- `~/.claude/promotion-queue.md`を読む。PROMOTE待ちがあれば手順2の目的候補へ`仕組み化: <name>`として含める。

## 1.5 実装提案が先頭にある場合

`next-session.md` の先頭が `<!-- PROPOSAL-SESSION START -->` なら、この提案1件の判断を本セッションの目的にする。後ろの別目的・後続キューはこのセッションで実行しない。

1. `~/.claude/proposals/<id>.json` と同名 `.md` を読み、提案・根拠・変更内容・費用効果・リスク・承認/却下後の動作を提示する。「承認なら『承認』、却下なら『却下 <理由>』」と案内し、回答前は Codex や autopilot を起動しない。提案IDと `revision` を控える。
2. kim がこの提案を「承認」したら JSON を再読し、提示した `revision` と一致することを確認する。追記で変わっていれば更新差分を提示して改めて判断を受ける。`onApprove.kind` が `codex-task` であることと指示書の実在・内容を確認し、配布元リポジトリの `node tools/codex-do.mjs --prompt-file "<onApprove.promptFile>" --cwd "<対象repo>"` を実行する。別目的への包括承認として扱わない。
3. Codex の結果を read-back し、関連テストと `git diff --check` を監督も実行する。生成doc型の変更なら `--write` → `--check` → 関連テスト。PR を作成（既存があれば再利用）して URL を提案 JSON に記録し、再開時は同じ PR を使う。CI と差分を確認後 `node tools/pr-merge.mjs <PR番号>` を実行し、GitHub の `state=MERGED`・`mergedAt` を確認する。失敗中・CI待ちは提案を未処理のまま保持する。
4. マージ確認後 `node tools/proposal-session.mjs --complete "<id>" --revision "<提示時の番号>" --decision approved --pr "<PR URL>"`。却下なら実装をせず `node tools/proposal-session.mjs --complete "<id>" --revision "<提示時の番号>" --decision rejected --reason "<理由>"`。シェル引数を適切に引用する。完了メッセージだけでなく `proposals/done/<id>.json` の status・理由・PR と次の引き継ぎを read-back する。
5. 完了処理は `.json`・`.md`・生成指示書を `done/` へ移し、キューの次の1件を先頭に登録する。元の引き継ぎは残る。次の提案は次セッションで扱う。`next-session.md` の提案ブロックを手で削除しない。

## 2. 目的を1件に確定する

- 引き継ぎに目的が書いてあればそれを採用し、着手前に1行で宣言する（`**[本セッションの目的]** …`）。
- **候補を kim に見せる前に、着手済みを機械で落とす**（重複着手の防止・トークン増ゼロ）:
  候補を1行1件でスクラッチパッドのファイルに書き、
  `node ~/orgiast-claude-rules/tools/session-claims.mjs --filter --self <このセッションのid> --candidates <そのファイル>`
  を通す。**stdout に残った候補だけ**を AskUserQuestion に出す。落ちた分は stderr に理由が出るが、kim には見せない。
  （このツールは他セッションの `**[本セッションの目的]**` 宣言を transcript から拾って突合する。
   着手印は自動で付くので、手で書く運用にしない）
- 未定・複数ある場合は AskUserQuestion で**1件だけ**選ばせる。候補は次から集める:
  - `~/.claude/next-session.md` の残TODO
  - `~/.claude/session-handoffs.md`（放置セッションの再開一覧。`/session-triage` が生成）
  - 直近の memory の「未決」「次アクション」記述
  - `~/.claude/promotion-queue.md`のPROMOTE待ち
- 選ばれなかった候補は `next-session.md` に残す（消さない）。

## 3. 完了条件を先に決める

- 「何が確認できたら終わりか」を検証手段まで含めて1行で書く（例: 「prod で該当 route を実叩きして 200、read-back で値一致」）。
- 完了条件が書けないタスクは、まず調査タスクとして切り直す。
- **決めた完了条件の検証コマンドを、着手前にその場で1回実行する。** 既に満たしていれば着手しない（引き継ぎは書かれた時刻の状態で、並行セッションが終わらせていることがある）。結果を1行報告し、`next-session.md` から当該項目を消して別の目的を選ぶ。
- **対象ファイルの衝突を見る。** 触る予定のファイルについて (1) `ls -l --time-style=full-iso <対象>` の更新時刻が数分〜数十分前なら並行セッションがいる、(2) `git status` に自分が触っていない `M` が出ていないか、(3) 実行中 node の CommandLine（Windows: `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`）に対象スクリプトが無いか。衝突したら実装の質で判断して譲り、API を使わず確定できる部分に回る。worklock は資源単位でファイルは守らない。

## 4. 分解して委譲する

- 監督（あなた）がやるのは 設計・分解・指示・レビュー・verify だけ。
- 実装本体は Codex（WSL 経由・定額枠）へ。渡す時は MEMORY.md と関連 memory の該当分をキュレートして同梱する（Codex は蓄積を継承しない）。
- 量産・分類・抽出は Groq / OpenRouter、長文脈は Gemini、中量級の生成は Kimi K3。

## 5. 着手する

- ここまでを1〜3行で報告してから作業に入る。長い前置きは書かない。
- 作業が1件終わったら `/session-close` を提案する（積み残しを増やさない）。

## 注意

- 引き継ぎファイルを読まずに「続きから」を始めない。文脈は履歴ではなく `next-session.md` と memory が担保している。
- 目的以外の依頼が来たら、着手前に「別セッションに分けましょう」と提案する。
- `next-session.md` は上書きでなく**採用した目的を消して残りを残す**形で更新する（他の残TODO を失わない）。
