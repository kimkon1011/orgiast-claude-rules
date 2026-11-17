# Beeper 中継（000 の Beeper を各PCから使う）

2026-11-17 kim 指示：「倉庫のDiscordはBeeperのAPIを000から配ることで、各パソコンから送れるようにする」。
Discord のグループDM（例「倉庫リーダー×倉庫社員」 `!Rymw7inNTS9Zh9mgvtHL:beeper.local`）は 008 の discord-dm.mjs（Bot）では送れない。Beeper なら kim 本人のアカウントで読み書きできる。

## 経路の選び方（tools/beeper-api.mjs が自動で選ぶ）

1. `BEEPER_API_BASE` を明示していればそれ。
2. そのPCに Beeper Desktop（同じ kimkon1011 アカウント）が入っていればローカル（`localhost:23373`）。2026-11-17 時点で 000・008・018・019・004。
3. 入っていないPC（014・011 など）は 000 の中継 `http://192.168.0.4:23380`（`%USERPROFILE%\.claude\secrets\beeper-gateway.json`）。
   `BEEPER_VIA_GATEWAY=1` でローカルより中継を優先できる。

画面操作（discord-post.ps1）で 000 の Discord アプリを動かすのは、Beeper が止まっているときの最終手段にする。

## 安全の決まり

- 中継は社内LAN `192.168.0.0/24`・Tailscale `100.64.0.0/10`・000 自身からだけ受ける。Tailscale Funnel（公開）には載せない。
- Beeper 本体のトークンは 000 から出さない。他PCには中継専用トークンだけを配る。値を表示・コピペ・チャット貼り付けしない（ファイルのまま移す）。漏れたら 000 で `beeper-gateway-token.txt` を消して `init-token` し、配り直す。
- 中継が通すのは読み取りとテキスト送信だけ（添付・削除・既読化・アセットは通さない）。中継側でも 1チャット1時間3通・全体1時間20通で止め、送信ログに本文は残さない。
- 送信は必ず `node tools/beeper-send.mjs --chat <id> --body-file <本文> --queue-id <id> --receipt <rid>` から。reply-queue の receipt（kim 承認済み）と send-context-check を通らない送信はしない。社外は承認必須・自動返信上限など既存の Beeper 方針はそのまま。
- 同じ文面を Discord アプリ（画面操作）と Beeper の両方から送らない。送る前に対象チャットの直近メッセージを読み、もう送ってあれば送らない。

## 設定手順

000（1回だけ）:
1. `powershell -ExecutionPolicy Bypass -File tools\register-beeper-gateway.ps1`（トークン作成・常駐タスク登録。値は表示しない）
2. `tools\beeper-gateway-firewall.cmd` を kim がダブルクリック →「はい」（LAN からの 23380 だけ許可。管理者承認が要るのはここだけ）

各PC（Beeper がないPC）:
1. 000 の `%USERPROFILE%\.claude\secrets\beeper-gateway-token.txt` を、値を出さずにファイルのまま対象PCへ移す（グロボの CopyToBox→CopyFromBox など）。
2. `powershell -ExecutionPolicy Bypass -File tools\beeper-gateway-client.ps1 -TokenFile <移したファイル>`（取り込み後に元ファイルは消える）
3. 疎通確認（読み取りのみ）: `node tools\beeper-gateway.mjs check 倉庫リーダー`
