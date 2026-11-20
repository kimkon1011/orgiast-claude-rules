# Beeper 中継（000 の Beeper を各PCから使う）

2026-11-17 kim 指示：「倉庫のDiscordはBeeperのAPIを000から配ることで、各パソコンから送れるようにする」。
Discord のグループDM（例「倉庫リーダー×倉庫社員」 `!Rymw7inNTS9Zh9mgvtHL:beeper.local`）は 008 の discord-dm.mjs（Bot）では送れない。Beeper なら kim 本人のアカウントで読み書きできる。

## Beeper 本体は 000 だけ（2026-11-17 kim 決定）

「全てのパソコンをBeeperのAPIで動かせるようにして、Beeperは000のパソコンだけ入っているように。他のパソコンに入っているBeeperはAPIが使えるようになれば削除して」。
000 以外のPCに Beeper Desktop を入れない・ログインしない。他PCは必ず 000 の中継 `http://192.168.0.4:23380` を使う。

## 経路の選び方（tools/beeper-api.mjs・comms-hub-sync.mjs が自動で選ぶ）

1. `BEEPER_API_BASE` を明示していればそれ。
2. 中継設定 `%USERPROFILE%\.claude\secrets\beeper-gateway.json` があれば 000 の中継（000 以外の全PC）。
3. 中継設定がない 000 自身はローカル（`localhost:23373`）。`BEEPER_PREFER_LOCAL=1` で中継設定があってもローカル優先。

画面操作（discord-post.ps1）で 000 の Discord アプリを動かすのは、000 の Beeper が止まっているときの最終手段にする。

## 000 の待ち受け方

000 の有線LANは Windows ファイアウォールの「パブリック」で、node.exe の受信は「プライベート」しか許可されていない。
管理者承認なしで動かすため、既に受信許可のある python.exe の転送（`tools/beeper-gateway-forward.py`、社内LAN/Tailscale の IP だけ受ける）を 23380 に置き、
node の中継は 127.0.0.1:23381 で待つ。`tools\beeper-gateway-firewall.cmd`（管理者「はい」1回）を実行済みなら、`register-beeper-gateway.ps1` は node を 23380 で直接待たせる。

## 安全の決まり

- 中継は社内LAN `192.168.0.0/24`・Tailscale `100.64.0.0/10`・000 自身からだけ受ける。Tailscale Funnel（公開）には載せない。
- Beeper 本体のトークンは 000 から出さない。他PCには中継専用トークンだけを配る。値を表示・コピペ・チャット貼り付けしない（ファイルのまま移す）。漏れたら 000 で `beeper-gateway-token.txt` を消して `init-token` し、配り直す。
- 中継が通すのは読み取りとテキスト送信だけ（添付・削除・既読化・アセットは通さない）。中継側でも 1チャット1時間3通・全体1時間20通で止め、送信ログに本文は残さない。
- 送信は必ず `node tools/beeper-send.mjs --chat <id> --body-file <本文> --queue-id <id> --receipt <rid>` から。reply-queue の receipt（kim 承認済み）と send-context-check を通らない送信はしない。社外は承認必須・自動返信上限など既存の Beeper 方針はそのまま。
- 同じ文面を Discord アプリ（画面操作）と Beeper の両方から送らない。送る前に対象チャットの直近メッセージを読み、もう送ってあれば送らない。

## 設定手順

000（1回だけ）:
1. `powershell -ExecutionPolicy Bypass -File tools\register-beeper-gateway.ps1`（トークン作成・常駐タスク登録。値は表示しない）
2. （任意）`tools\beeper-gateway-firewall.cmd` を kim がダブルクリック →「はい」すると python 転送を使わず node が直接待つ。しなくても python 転送で動く。

各PC（000 以外の全PC）:
1. 000 の `%USERPROFILE%\.claude\secrets\beeper-gateway-token.txt` を、値を出さずにファイルのまま対象PCへ移す（グロボの CopyToBox→CopyFromBox など）。
2. `powershell -ExecutionPolicy Bypass -File tools\beeper-gateway-client.ps1 -TokenFile <移したファイル>`（取り込み後に元ファイルは消える）
3. 疎通確認（読み取りのみ）: `node tools\beeper-gateway.mjs check 倉庫リーダー`
4. 中継で読めたら、そのPCの Beeper Desktop を終了してアンインストールする（kim 承認済み 2026-11-17）。Beeper に依存する常駐処理（comms-hub-sync の line-chat 等）は、先に中継経由で動くことを確かめてから消す。000 の Beeper は消さない。
