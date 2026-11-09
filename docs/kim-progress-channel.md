# kim への進捗の届け方 仕様書（kim-progress-channel）

## 1. 目的・基本原則
- kim が「進捗どう？」と聞かなくても、全 PC・全アカウントの進行・完了・判断待ち・停滞状況が毎朝定時に 1 通で正確に届く状態を維持する。
- セッションや PC ごとに報告経路を無断変更・逆転させる退行を機械的に止め、報告経路の正本を本仕様ファイル `docs/kim-progress-channel.md` に一元固定する。

## 2. 届け先と優先順位（1 日の通数上限）
kim が明示変更するまでの既定経路は以下の 3 つに限定する。

1. **毎朝 08:40 統合ダイジェスト（Discord DM）**
   - 宛先: Discord DM（ClaudeInboxBridge → kim, チャンネル `1509558231687757846` / ユーザー ID `715210673642012733`）。
   - 上限: 毎朝 08:40 に **1 通**（1800 文字×最大 3 分割メッセージ）。席ご別の個別送信は禁止。

2. **Google Drive Doc「Claude 進捗まとめ（毎日更新）」**
   - URL: `https://docs.google.com/document/d/1234567890abcdefghijklmnopqrstuvwxyz/edit?authuser=kim@orgiast.jp` (kim@ 編集権限付き, URL 固定, スマホ閲覧可)。
   - 毎朝 Discord DM と同一の本文を Google Drive ドキュメントへ上書き更新する。

3. **セッション起動時（SessionStart）の kim-inbox 一覧**
   - 表示範囲: 「判断待ち上位 5 件＋件数サマリー」のみ。注入プロンプト文字数は **6KB（6144 文字）以下**。
   - 全件確認・操作コマンド: `node tools/kim-inbox.mjs --list --open`

## 3. 統合の仕組みと役割分担
- **集約**: 各 PC は毎朝 08:00 までに、自席の進捗 JSON（完了 / 進行中 / 止まり / 判断待ち、各行に席名・案件名・PR・次の手）を fleet ハブ / 共有台帳へ配置する。
- **リーダー送信**: `fleet-pc-map.json` の `digestLeader`（既定: `作業用011`）のみが 08:40 に全 PC 分を結合して Discord DM および Drive Doc へ送る。
- **他席の禁止**: leader 以外の PC は Discord DM への個別送信を行わない（送信数 0）。

## 4. 本文の構成と記載ルール
ダイジェスト本文は以下の①〜⑤の順番で構成し、各行の先頭には必ず席名（`［作業用011］` など）を明記する。

① **kim の判断待ち**（全件・何を決めるかを 1 行で明記。返信はこの DM への返信で可）
② **昨日完了**（案件名 / PR / 成果物）
③ **進行中**（次の手）
④ **止まっている**（原因）
⑤ **社外返信待ち**（既存の【社外返信待ち】通知を統合し、別通にしない）

### 禁止事項
- **席ご別の別送**: leader 以外の PC が個別に進捗 DM を送信すること。
- **数字だけの行**: 「達成 0件／未達 1件」のような案件名・詳細を欠く断片行。内容がない項目セクションは行ごと省略する。
- **無断の経路変更**: 本仕様ファイルを更新せずにコードや CLAUDE.md / ONBOARDING.md の報告経路を変更すること。

## 5. 退行防止の機械ゲート
- テストファイル: `tools/kim-progress-channel.test.mjs`
- CI 検証内容:
  (a) digest 送信先が `docs/kim-progress-channel.md` の既定（`config/kim-discord-allowlist.json` および Discord チャンネル ID `1509558231687757846`）と一致すること。
  (b) leader 以外の席設定で dry-run した際の Discord 送信数が 0 であること。
  (c) SessionStart 時の注入 context 文字数が 6KB (6144 文字) 以下であること。
