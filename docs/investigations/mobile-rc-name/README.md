# Remote Control 名の実測記録（未完了）

実測日時: 2026-09-24 18:57–18:58 JST。対象: DESKTOP-2D0R4LI。

## Step 1-a: 新規タブと登録時期

- Windows の `C:\Users\uers\.local\bin\claude.exe agents --json` を実行。前28件、後30件。証跡: `agents-before.json` / `agents-after.json`（作業ディレクトリは省略）。
- `code --open-url 'vscode://orgiast.next-session/mobile?count=1&name=RC-name-probe-20260924'` を実行し、終了コード0。
- Orgiast Next Session ログで以下を確認:

```text
2026-09-24T09:57:20.758Z mobile tabs: existing=0 target=1 name=RC-name-probe-20260924
2026-09-24T09:57:20.989Z mobile tab created: RC-name-probe-202609241
```

- 本検証ではメッセージを送信していない。
- `~/.claude/sessions/*.json` の新規2件は `entrypoint: claude-vscode`。双方に `bridgeSessionId` が存在。抽出結果は `new-session-state.json`。
- Claude VSCode ログに `2026-09-24T09:58:07.144Z [DEBUG] [remote-bridge] Created session cse_018nWnPqE5WW2WUZSC6sqpZE` を確認。新規ローカルセッション `9401aac8-c7b4-4cca-8572-9dc18b42817a` の bridgeSessionId と接尾部が一致。
- 新規2件に対応する `~/.claude/projects/*/<sessionId>.jsonl` は観測時点では見つからなかった。これだけで最初のメッセージの有無は断定しない。
- 1タブ作成に対し2件増えたため、検証タブとローカルセッションの一対一の対応は未確定。スマホ一覧自体の表示も未観測。したがって「タブを開いた時点か、最初のメッセージ送信時点か」の最終判定は未確認。
- agents の新規 name は `claude-md-58` と `claude-md-a6`。RC 一覧の表示名と同一かは未確認。

ログの所在: `%APPDATA%\Code\logs\20260923T045101\window1\exthost` 配下の `output_logging_20260923T045105\4-Orgiast Next Session.log` および `Anthropic.claude-code\Claude VSCode.log`。

## Step 1-b: 未実施

このセッションの書き込み許可範囲はリポジトリと `/tmp` のみ。`~/.claude/settings.json` と `%APPDATA%\Code\User\settings.json` は範囲外で、権限昇格も許可されていない。別の実行経路による制約回避は行わない。設定の変更は一切しておらず、復元対象もない。

## Step 2 / Step 3: 未実施

Step 1 未完了につき A/B は選択していない。別プロセスの RC ホストについても起動・VSCode 会話表示とも未検証。実装変更なし。

リポジトリには着手前から多数の未コミット変更があり、対象 extension.js と package.json も変更済み。これらは編集していない。現在ブランチは `fix/negative-claim-gate-restore-v2`。`.git` が明示的に読み取り専用のため `feat/mobile-rc-name` の作成・commit は実行せず、PR も作成していない。

検証タブ `RC-name-probe-202609241` は作成確認済みで、閉じたことは未確認。既存の作業タブとの誤対応を避けるため、プロセス終了は行っていない。

継続には、対象の Windows 設定ファイルと `.git` への書き込みが許可された実行環境が必要。その環境でタブと sessionId の対応を確定し、設定をバックアップしてから Step 1-b を実施する。実装する場合は新規導入と既存PCへの自動展開の両経路を確認する。
