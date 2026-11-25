aliases: [マクロドロイド, Macro Droid]

# MacroDroid（Galaxy）— 通知を Claude PC へ転送する実測手順

正本: `~/.claude/playbooks/MacroDroid.md`（全PC共通の初期版はリポジトリ `playbooks/MacroDroid.md`）。
出典: セッション 328c5909（LINE 転送の確立・2026-10）、ed6874f9（WeChat 転送・2026-10-15）、c337ec64（LINE オープンチャット調査）、memory `feedback_macrodroid_reuse_past_setup.md`、受け口コード `claude-mobile/app/api/line-ingest/route.ts`。
ここに書いてあるのは実測だけ。無い部分は過去ログ（`~/.claude/projects/**/*.jsonl` を `MacroDroid` で Grep）を見てから書く。

## 既存の構成（kim の Galaxy）

- 既存マクロ名: **`LINE to PC`**
  - トリガー: Notification Received（**Device Events** の中にある。Add Trigger の一覧の一番上には出ない。出なければ検索窓で探す）／アプリは LINE のみ／Text Content は空欄
  - アクション: HTTP Request 1個
  - Constraint: なし
- LINE の普通のトークはこのマクロで実際に PC へ届いている（実測）。大規模オープンチャット（1,366人）だけは LINE 側の通知抑制で通知が0件だった。

## 別アプリ（WeChat 等）を追加するときの最少手順

1. 既存の `LINE to PC` を**複製**して、トリガーのアプリだけ差し替えるのが最少手数（memory の結論。※実際に複製した記録はまだ無い。2026-10-15 の WeChat は新規作成で案内した）。
2. トリガーのアプリ選択: 対象アプリ（例 WeChat）だけにチェック → **Include** を選ぶ。ALL は押さない。Exclude は選ばない。Text content は Any、Prevent multiple triggers は OFF。
3. マクロ名を付ける（例: `WeChat転送`）。

## HTTP Request アクションの設定値（実測で動いた値）

- Method: **POST**（既定は GET なので必ず変える）
- URL: `https://claude-pc.tailc5d751.ts.net/api/line-ingest?t=<token>`
  - `<token>` は `claude-mobile/.env` の `LINE_INGEST_TOKEN` の値。**ここにも会話にも値を書かない**（必要なら Claude が .env から読んで、user には貼り付け用の完成文字列だけを1回渡す）
- Content Type: `application/json`。追加ヘッダは不要。
- Body（LINE 用・動作実績あり）: `{"chat":"{notification_title}","sender":"","text":"{notification_text}"}`
- Settings タブ（POST・URL・timeout）は過去のスクショ診断で問題なし。詰まったのは Body の変数だけ。

## Magic Text（変数）の入れ方 ← 一番ハマる所

- **手打ち禁止**。`{notification_title}` を自分で打つと版差で空のまま送信される（実害あり）。
- 入力欄右の水色の `{ }`（または `[...]`）ボタン → **Notification** → **Notification Title** / **Notification Text** を選んで挿入する。
  - 該当グループが出なければ検索窓に `title` と打つ。
  - ボタンが見えなければキーボードを閉じる。
- 括弧の形式: 既定は Curly `{value}`。過去のスクショでは画面に `[notification_title]` と角括弧で表示されていたこともある → **ボタン経由で挿入すれば形式は気にしなくてよい**。手で括弧を書き換えない。
- 受け口は `[notification` `{notification` `[not_` `{not_` が残ったデータを「未展開」として捨てる（ログに skip が出る）。届かないときはまずこれを疑う。

## 通知へのアクセス許可

- トリガー横の**赤い ⚠** は「MacroDroid に通知を読む許可が無い」印。
- 最短: マクロ保存時／トリガー追加時に出る案内で OK → 開いた Android の画面で MacroDroid を ON → 確認ダイアログで **Allow**。
- MacroDroid アプリの Settings タブにはこの項目は**無い**。本体側の経路は 設定 → 通知 → 詳細設定 → 通知へのアクセス（Notification access）。
- それでも動かないとき: MacroDroid 左上 ≡ → **Troubleshooting** で足りない許可を確認する。

## 受け口（PC 側）の仕様 — 手順を渡す前に Claude 側で確認すること

- `/api/line-ingest` は `?t=` のトークンで認証。JSON は `chat`（200字まで）、`sender`、`text`（8000字まで・必須）、`ts`（任意）。
- `text` が空、または未展開の Magic Text が残っていれば skip。
- **`chat` が許可リスト（環境変数 `LINE_INGEST_ALLOW_CHATS`）に無いと保存せず捨てる**。2026-10-15 時点は LINE のチャット名4件のみ。新しいアプリ（例: `WeChat:` 接頭辞）を流す前に、Claude 側で許可リストへ追加してデプロイしておく（user の手順に入れない）。
- 重複は `chat\0sender\0text` のハッシュで判定し、10分以内の同一 id は除外。

## 失敗の記録

- LINE: Body の変数を手打ちして空送信 → kim がスクショ2枚で往復約2回。`{ }` ボタン経由で解決。
- WeChat（2026-10-15）: 一般知識で手順を書き、上記の実測を探さなかったため同じ失敗を再生産しかけ、kim が何往復もした。Body の text に `[notification]` を使った案内をしたが、展開されるかは未検証。WeChat の受信成功はまだ記録が無い。
