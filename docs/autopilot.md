# autopilot

## 制御チャンネルの作り方

1. Discord に制御用のテキストチャンネルを作り、既存 Bot に View Channel / Read Message History とメッセージ本文の読み取り権限を与える。
2. 開発者モードでチャンネル ID をコピーし、`~/.claude/orgiast-autopilot-channel-id.txt` に UTF-8 BOM なしで保存する（省略時は `orgiast-inbox-channel-id.txt`）。
3. `orgiast-discord-user-id.txt` の kim のアカウントから「続けて」「止めて」「一時停止」「目的変更: …」を送る。通知 DM への返信も有効。

`/autopilot start "目的"` で開始。上限の既定は20周/日・6時間/日・noop 3連続・累計200周。日付は JST、時間は指定どおり当日ログの最初と最後の ts の差（CPU時間ではなく待ち時間を含む）。設定は `~/.claude/autopilot/objective.md` の JSON を編集できる。`AUTOPILOT_HOME` は状態ディレクトリそのものの上書きで、Discord 設定と next-session.md のホームは `ORGIAST_HOME` または OS のホーム。テスト時は両方を一時ディレクトリに向ける。

`node tools/autopilot-tick.mjs status --pretty` は JSON を維持したまま、人向けの text フィールドと整形を追加する。すべての tick コマンドは exit 0 なので error フィールドを確認する。start をやり直すと旧状態・目的・ログは archive ディレクトリに保存される。

既存 PC にも `setup.mjs --converge` → `onboarding-sync.mjs --force` → `deploySkills` の経路で配布される。タスクは新規 PC・既存 PC とも自動登録しない。kim の承認後に各アカウントで `powershell -NoProfile -ExecutionPolicy Bypass -File tools/register-autopilot-task.ps1` を実行する。

対話 `/loop` は画面を開いたまま・PC スリープ不可。停止すると Discord の監視も止まるので `/autopilot resume` が必要。定期 runner が登録済みなら、停止中も30分ごとの pre で Discord の再開・目的変更を読み、run の時だけ Claude を起動する。対話ループと定期 runner は同時に使わない。

`autopilot-run.mjs` は policy の planIncluded=true なら `claude-fable-5-1`、それ以外は `claude-opus-5`。別アカウントでは定額対象であることを確認して policy を設定する。1回25分で打ち切り、post 未記録の失敗も noop として番犬に数える。stdout 末尾と終了コードは autopilot/run.log。完了済みは単なる「続けて」で再開せず、新しい start または目的変更を使う。日次上限は翌日以降に明示的に再開し、累計上限は resume では解除されない。
