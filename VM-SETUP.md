# クラウドVM内の Claude Code をオージャスト共通運用に参加させる手順（Muse / Grok Bot 等）

対象: Meta Muse の Secure VM、Grok Bot の作業環境など、**Linux のクラウドVMで動く Claude Code**。
Windows 用の `STANDARD-PC-SETUP.md`（PowerShell・VS Code・タスクスケジューラ前提）はこの環境では動かないので使わない。

このファイルを読んだ Claude Code は、下の手順を上から順に**自分で**実行する。
ラベル（例 `MUSE-VM` / `GROKBOT-VM`）は依頼文で渡される。渡されなければ止まって聞く。

## 目的（3つ）
1. 共通ルール（~/.claude/CLAUDE.md・hook・許可ルール）を他PCと同じにする
2. 監視対象に入れる（fleet ビーコン送信）
3. 他PCの Claude Code と連絡を取り合えるようにする（fleet-mail の定期受信）

## 禁止（kim の承認があるまで）
- 会社の API キー・keyserve 登録・1Password 鍵をこのVMに入れない。`onboarding-sync` 等が鍵の登録・入力を求めたらスキップして結果表に「鍵: 未導入（承認待ち）」と書く
- 秘密値・トークンを画面に表示しない
- 社外へのメール送信・購入・予約・削除をしない
- Claude Code を API キー（ANTHROPIC_API_KEY / apiKeyHelper）や Console アカウントで動かさない

## 手順
### 0. 前提確認（1つでも NG なら、その出力を貼って止まる）
- `uname -a`、`cat /etc/os-release`、`claude --version`、`git --version`、`node -v`
- `env | grep -c ANTHROPIC_API_KEY` が 0 であること。`claude` のログインが Claude アカウント（Team/サブスク）であること（API キー・Console なら止まる）
- `crontab -l` が使えるか（使えなければ「cron なし」と記録して続行）、`uptime`

### 1. Node.js（20 以上）が無ければ入れる
apt が使えれば `nodejs`、無ければ nodejs.org の `linux-x64`（arm なら `linux-arm64`）tarball を `~/.orgiast/node` に展開して PATH に足す（sudo 不要の方法を優先）。

### 2. 共通ルール一式を取得
- 無ければ `git clone https://github.com/kimkon1011/orgiast-claude-rules ~/orgiast-claude-rules`
- あれば `git -C ~/orgiast-claude-rules pull --ff-only`

### 3. ONBOARDING.md を取り込む
`~/orgiast-claude-rules/ONBOARDING.md` を `~/.claude/CLAUDE.md` に BEGIN/END マーカーでマージする（既存があれば先に `~/.claude/CLAUDE.md.bak-<日時>` へ退避）。

### 4. hook・許可ルールを収束させる
`ORGIAST_LABEL=<ラベル> node ~/orgiast-claude-rules/tools/setup.mjs --converge`
Windows 専用の項目で失敗したものは、エラー1行を結果表に残して続行する（Linux で不要な項目は不要と書く）。

### 5. 監視対象に入れる
`ORGIAST_LABEL=<ラベル> node ~/orgiast-claude-rules/tools/fleet-beacon.mjs --install-beacon --installer vm-1`

### 6. 連絡（fleet-mail）を有効にする
- `node ~/orgiast-claude-rules/tools/fleet-mail.mjs --poll --no-exec` を1回実行し、成功することを確認
- cron が使えるなら crontab に次の3行を追加（Windows のタスクスケジューラ相当。node の絶対パスを使う）
  - 15分ごと: `fleet-mail.mjs --poll`
  - 1日1回: `onboarding-sync.mjs`（最新ルールの取込）
  - 1日1回: `fleet-beacon.mjs`（生存報告）
- `register-fleet-mail.mjs` は Windows 専用（Linux では何もしない）なので、上の cron で代わりにする

### 7. 接続テスト
本文を `~/vm-hello.txt` に書き（`<ラベル> 接続テスト hostname=<hostname の値>`）、
`node ~/orgiast-claude-rules/tools/fleet-mail.mjs --send --to kim-PC --body-file ~/vm-hello.txt --why "VM参加の接続テスト"`

### 手順5〜7 の前提: `~/.claude/fleet-sheet.env`
ビーコンと fleet-mail は `~/.claude/fleet-sheet.env`（FLEET_SHEET_URL / FLEET_SHEET_TOKEN）が無いと `unconfigured` でスキップする。
値は **kim が依頼文の中で渡す**（2026-11-07 kim 承認: 全PC共通の値を VM にも入れる）。
- 依頼文に `FLEET_SHEET_URL=` / `FLEET_SHEET_TOKEN=` / `REPORTER_HOST=` の行があれば、手順5の前にその行だけを `~/.claude/fleet-sheet.env` に書き、`chmod 600` にする。値は画面・結果表・fleet-mail 本文に再表示しない
- 依頼文に無ければ**自分で作らない・他から探して持ち込まない**。5〜7 を「値待ち（unconfigured）」と結果表に書き、cron 登録（6）だけ済ませる（値が届けば自動で動き出す）

### 8. 結果表を出す
| 項目 | 結果（OK/NG/不要） | 証拠（出力1行） |
を 0〜7 の全項目について出す。最後に `hostname` とラベルを1行で書く（kim-PC 側でこの名前を台帳に登録する）。
