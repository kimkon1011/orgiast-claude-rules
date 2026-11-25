# 全PC・OSユーザー別の配布収束

PC名＋OSユーザー名を主キーにフリートシートへ報告する。Claudeアカウントは `~/.claude.json` の `oauthAccount.emailAddress` がある場合だけ記録し、未取得は空欄。アカウントを切り替えた同一OSユーザーは最新ログインの1行になる。未知のユーザーを列挙する機能ではない。

`fleet-convergence-report.mjs` は同期先の絶対パス、HEAD、参照main、未反映commit数、最古未反映commit日時、hook不足数、必須キー欠落数、現在の報告時刻を送る。秘密値は送らない。hookの期待集合は `register-hooks --expected-json` で実際の登録処理から生成し、イベント・matcher・コマンド・非同期指定を照合する。独自hookは残す。キーは配布manifestの各名前の非空を確認する。Git/期待集合/manifestが取れなければ0でなく「未確認」。通常点検は既存指標を維持し、同期完了時の軽量報告は収束列だけ更新する。GASは書込直後に読み戻し、クライアントは収束IDの応答がなければ失敗扱いにする。

kim-PCの `nightly-health` が最新mainを取得して比較する。24時間以上古い未反映commit、hook不足、キー欠落、48時間無報告、収束未導入/未確認が対象。専用fleet-mail宛先（hostnameとOSユーザーのハッシュ）へ許可済み固定操作 `rules-resync` を日次送付する。同一ユーザーへの送付・実行は24時間に1回。送付タイムアウトは同じmail IDで再試行する。受信者はsender、宛先、対象ユーザー、期限、操作の固定値を検証し、`onboarding-sync --force` のみNodeから起動する。本文から実行パスや任意コマンドを選択できず、promptのopt-inは変更しない。

24時間後も未達ならkimへ1日1回DMを集約する。報告がない行はOSユーザーを推測せず「未確認・宛先未確定」として残す。最初の配布では従来 `fleet-command.json` の `rules-resync` を全PCへ1回出し、古いクライアントにも新受信処理を届ける。電源OFF/初回未導入PCの起動やログインは遠隔保証できない。受領確認はmailの送付成功ではなく収束シートの新しい実測値で行う。

## 3a: 同じWindows PCの別ユーザー

設定はユーザーのHOMEごとに独立する。配布リポの `.claude/settings.json` にあるSessionStartが初回に `session-bootstrap.mjs` を起動し、そのユーザーのhookを冪等登録、同じ起動で同期する。次セッションからユーザー設定のhookが全プロジェクトで動く。別ClaudeアカウントでもOSユーザーが同じなら同じ設定を使う。未導入ユーザーが配布リポを一度も開かず別リポだけ使う場合はこの入口に届かないため、初回bootstrapが必要。全25行・全ユーザーの実機確認は未確認。

## 3b: macOS / Linux

登録・同期・軽量報告・固定再同期受信はNodeでwin32/darwin/linux共通。新規のlaunchd/cronは追加せず、既存POSIX bootstrapとSessionStartの日次自己更新を使う。Windows専用nightly-bootstrapをMacで起動する設計ではない。CI test-posixでdarwin/linux経路と別HOME登録を検証する。Mac実機での起動は未確認。

## 3c: Web / クラウド（調査のみ）

端末の `~/.claude/settings.json` とローカルhookはクラウドへ自動転送されない。公式[Hooks reference](https://code.claude.com/docs/en/hooks#configuration)はプロジェクト `.claude/settings.json` による共有hookとクラウドのhookイベントを説明している（2026-10-09確認）。したがって「クラウドにはhook機能がない」ではなく「端末の個人設定がそのまま効かない」。

案: 各対象リポに、リポ内ファイルだけ参照するPreToolUse/Stopゲートを登録する。Node等の実行環境、ネットワーク、managed settingsの制限、workspace trust、相対パスを確認し、クラウド用テストで検証する。端末配布用のbootstrapは `CLAUDE_CODE_REMOTE=true` ではスキップし、クラウドにPC秘密鍵を配布しない。クラウド用ゲートの実装・実機検証は対象外。

## 3d: keyserve auth=unset

既存のenroll.env/legacy認証経路を再利用する。primary未設定時の失敗も試行時刻を残し、SessionStartで1日1回再試行する（`--force` は明示的再試行）。トークンは `enroll.env` の `ORGIAST_ENROLL_TOKEN`、ASCII名は `ORGIAST_KEYSERVE_PC`。既存の日本語hostname回避処理を維持する。トークン未発行・期限切れを自動発行できるとは扱わず、未達として報告する。

## 運用と検証

GAS変更は既存本番をpullしたoverlayに `UpsertLogic.gs,WebApp.gs` だけ重ね、同一Web App deploymentへ反映してread-backする。他の本番ファイルをリポの古い版で上書きしない。マージ後にkim-PCの本来の同期先とWindowsユーザーで軽量報告を実行し、シートから同じ収束ID・HEAD・不足数を読み戻す。

テスト: `node --test`。`fleet-convergence.test.mjs` は報告内容、秘密値非出力、別ユーザー行、未知状態、24/48時間境界、送付/通知/実行抑制、失敗時再試行、固定操作の拒否、darwin/linux/win32初回登録、GAS未配布検出を検証する。
