Discord #claude-code に投稿された判断依頼が kim-PC で検知されず、対応が止まる問題を修正します。`[判断依頼]`・`【判断依頼】`・`[要返信]` を含む新着を10分ごとに検出し、kim への DM と fleet inbox の note に渡します。

- 初回は直近20件のうち48時間以内のみ。`[kim-PC]` を含む返信は対象外。
- `notify-kim` のトークン取得、`fleet-mail` のPCラベル判定を共用。kim-PC以外では通信しません。
- seenによる再送抑止、排他ロック、失敗最大3回の永続化、50件超のページ送りに対応。失敗した投稿はcursor更新後も再試行します。
- inboxは既存hookに合わせ `mail-discord-<id>.json`。返信先のDiscordリンクと「kim の Discord アカウントで開く」を記載します。
- `setup --converge` で `OrgiastDecisionWatch` を登録するmanifestとWindows登録スクリプトを追加。既存FleetMailと同様にnightly-bootstrap経由でmainの同期済みrepoを実行します。
- `--dry-run` はDM・inbox・状態ファイルを変更しません。無人実行は常にexit 0、未設定・実行エラーはstderrへ出力します。

検証:

```text
node --test tools/decision-watch.test.mjs tools/notify-kim.test.mjs tools/fleet-mail.test.mjs tools/fleet-inbox-context.test.mjs tools/setup.test.mjs tools/register-fleet-bootstrap.test.mjs
Windows: tests 80 / pass 80 / fail 0 / skipped 0
node --test tools/decision-watch.test.mjs
WSL: tests 15 / pass 15 / fail 0
PowerShell Parser: PASS
git diff --check: PASS
```

このPCのWindows側設定で `node tools/decision-watch.mjs --dry-run` を実行し、指定の2件を検出しました。実DM送信と稼働タスクの登録は行っていません。マージ後に `setup --converge` で登録されます。

```text
[dry-run] id=1558060797459169290
[判断依頼] cr-PC 移管: keyserve enroll と fleet 名簿登録の依頼
投稿者: clawd-connector
投稿時刻: 2026-10-09T10:17:21.484000+00:00
選択肢: A) kim-PC で keyserve-enroll.mjs の enroll トークンを発行し、fleet-sheet.env の配布と fleet-pc-map.json への「作業用011」追加を行う B) Supabase の配布だけ保留し、enroll と fleet 登録だけ先に行う
推奨: B（§1 最終行の Supabase 配布は kim 判断待ちのため。enroll と fleet 登録は移管に必須）
期限: 2026-10-12（過ぎたら止める。権限付与のため推奨案では進めない）
https://discord.com/channels/715211007307284530/1508437329247862794/1558060797459169290
（kim の Discord アカウントで開く）
[dry-run] id=1558088285698392084
[判断依頼] 制作アプリ: GitHub master が本番 GAS より大幅に古い
投稿者: clawd-connector
投稿時刻: 2026-10-09T12:06:35.191000+00:00
選択肢: A) スナップショットを master にマージし、以後の正にする B) kim-PC の未 push の作業を先に push してもらい、cr-PC で統合する C) 当面は master を使わず、スナップショットのブランチを正として作業する
推奨: B → A（kim-PC の手元に本番と違う未完成の作業があると、cr-PC の push で消える恐れがあるため。無ければ A）
期限: 2026-10-11（過ぎても止めたまま。本番データの消失に関わるため）
https://discord.com/channels/715211007307284530/1508437329247862794/1558088285698392084
（kim の Discord アカウントで開く）
```

作業ブランチ: `feat/decision-watch-20261009`（origin/main起点）。既存rescueツリーは変更していません。元のGit管理領域がsandbox外のため、workspace内 `.wt/decision-watch-git` に独立したbare cloneを置き、`.wt/decision-watch` をgit worktreeとして作成しました。
