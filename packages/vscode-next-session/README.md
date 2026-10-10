# Orgiast Next Session

`vscode://orgiast.next-session/start` を受け取り、VS Code の統合ターミナルで Claude CLI を起動する極小拡張です。公式 Claude Code 拡張の URI は初期プロンプトを入力欄へ置くだけで送信しないため、次セッションを操作ゼロで開始する用途に使います。

## インストール

```sh
code --install-extension orgiast-next-session-0.3.6.vsix --force
```

通常は `tools/next-session-launch.mjs --target vscode-ext` が未導入時だけ同梱 VSIX を自動インストールします。

導入済みの版が同梱 VSIX より古い場合も、自動的に `--force` 更新します。

## スマホ Remote Control 用タブ

既定の待機数は1本です。最初のプロンプトによりタブの自然なタイトルが変わると、次の空タブを補充します。閉じた場合も補充します。使用中のタブや既存の余剰タブは閉じません。余剰がある間は追加を停止するため、起動済みの余剰分を削除せずに運用できます。

待機数の決定順は、環境変数 `CLAUDE_MOBILE_STANDBY` → `~/.claude/mobile-sessions.json` の `{"count": 1}` → VS Code 設定 `orgiast.nextSession.mobileTabs` → 1 です（1〜10本）。`mobileTabs=0` は起動時の補充を無効化する既存の設定として残します。

タブの作成は、`claude-vscode.newConversation` → `claude-vscode.editor.open` → `vscode://Anthropic.claude-code/open`（`vscode.env.openExternal`）の順に試し、各手段で5秒以内にタブ総数が増えた時点で成功とします。成功した手段は次回最初に試します（タブ0本の初回のみ `editor.open` を先頭にします）。失敗しても `pendingTabCount` で止まらず、失敗から30秒で再試行し、連続5回失敗で10分休止、1時間あたり最大20回までです。Output「Orgiast Next Session」には、値が変わったときと作成を試したときだけ、ISO時刻・手段名・前後のタブ総数・新しく増えたタブのラベルを出力します（状態ファイルは従来どおり5秒ごとに更新）。

`node tools/mobile-sessions.mjs --count 1` でも URI 経由で補充できます。`--name` は呼出元との互換性のため受け付けますが、タブの改名はしません。公式拡張2.1.278では改名コマンドが入力ダイアログを開き、固定タイトルは使用開始の検出も妨げるためです。待機判定は公式拡張の空セッション名 `Claude Code` に基づきます。待機タブに手動で固定名を付けないでください。旧版が改名済みのタブの未使用判定はできません。

URI、起動時、タブ変更、5秒ごとの補充は同じ処理で直列化します。ウィンドウ間はループバックの39741番ポートを排他制御に使い、1つのウィンドウだけが補充します。ポートの取得に失敗した側は起動しません。起動したタブを確認できない間は追加コマンドを送らず、遅延による重複も防ぎます。

`node tools/mobile-sessions.mjs --dry-run` は状態ファイル（拡張が5秒ごとに更新）から「現在の待機数 / 目標 / 起動する本数」を表示します。起動・設定変更はしません。30秒以上古い状態、未導入・停止中の拡張は `不明` と表示し、0本と誤認しません。WSLからWindows側を確認するときは `ORGIAST_HOME=/mnt/c/Users/uers` を指定します。

### 定期リフレッシュ

スマホの Claude Code（Remote Control）一覧は新しい順に並ぶため、何時間も前に作った待機タブは下に沈んで見つかりません。待機セッションに発言させると消費してしまうので、代わりに**古い待機タブ（ラベル `Claude Code`）を 1 本閉じ、補充で新しい待機タブを作り直します**（新セッションとして登録され直し、一覧の上に出ます）。

- 条件（ownership を持つウィンドウだけ、1 分ごとに判定）: 有効、時間帯内、前回から間隔以上、待機タブが目標数以上（不足中は補充を優先して何もしません）。
- 対象は待機タブのうち最古の 1 本です。古さは拡張が記録したタブ出現時刻（起動時に既存タブは起動時刻）で判定し、出現から 10 分未満のタブと、いま開いている（アクティブな）タブは対象外です。
- 実行時は Output に `mobile refresh closed=<ラベル> age=<分> waitingBefore=<本数>` を出し、状態ファイルへ `lastRefreshAt` を保存します。`node tools/mobile-sessions.mjs --dry-run` が「最終リフレッシュ」を表示します。
- 即時実行: `node tools/mobile-sessions.mjs --refresh`（`--count` と併用可、URI は `/mobile?refresh=1`）。時間帯・間隔の条件は無視しますが、10 分未満除外と不足中の除外は維持します。

設定キー（決定順: 環境変数 → `~/.claude/mobile-sessions.json` → VS Code 設定 → 既定）:

| 項目 | 環境変数 | JSON キー | VS Code 設定 | 既定 |
|---|---|---|---|---|
| 間隔（分、0 で無効） | `CLAUDE_MOBILE_REFRESH_MINUTES` | `refreshMinutes` | `orgiast.nextSession.mobileRefreshMinutes` | 60 |
| 時間帯（ローカル時刻、終了は排他） | `CLAUDE_MOBILE_REFRESH_HOURS` | `refreshHours` | `orgiast.nextSession.mobileRefreshHours` | `06-24` |

副作用: 閉じた古い待機セッションの行は、スマホ一覧に offline として残ります（セッション自体は未使用のため実害はありません）。

この変更はタブの補充を担当します。別の `claude-mobile` サーバーやスケジュールタスクを停止・変更しません。実機の補充・定期リフレッシュには同梱0.3.6 VSIXの導入が必要です。

URI は外部プロセスやブラウザからも開けるため、`claude` パラメータは実在する絶対パスかつファイル名が `claude` / `claude.exe` の場合だけ実行します。

## アンインストール

```sh
code --uninstall-extension orgiast.next-session
```
