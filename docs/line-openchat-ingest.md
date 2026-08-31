# LINEオープンチャット AI情報ダイジェスト

この仕組みは、Galaxy に届いた指定LINEオープンチャットの通知だけをパソコンへ保存します。夜間に安価なAIが新しい情報を選別し、翌朝読む Markdown を作ります。LINEの発言は未確認情報なので、設定変更の提案には必ず「要検証」と表示します。

## 1. パソコン側のファイルを配置する

1. `route.ts` を claude-mobile の `app/api/line-ingest/route.ts` にコピーします。
2. `line-digest.mjs` を orgiast-claude-rules の `tools/line-digest.mjs` にコピーします。
3. claude-mobile の環境設定に `LINE_INGEST_TOKEN` を追加します。英数字を混ぜた長い、推測されにくい文字列にしてください。
4. 同じ環境設定に `LINE_INGEST_ALLOW_CHATS` を追加します。受け取りたいオープンチャット名を、カンマで区切って正確に書きます。未設定のままでは安全のため全通知を拒否します。
5. `~/.claude/groq.env` に `GROQ_API_KEY=取得したキー` を保存します。予備として DeepSeek を使う場合は `~/.claude/deepseek.env` に `DEEPSEEK_API_KEY=取得したキー` を保存します。

## 2. MacroDroid を設定する

MacroDroid は LINE の通知が来た時だけ動きます。トリガーを「通知を受信」、アプリを LINE にし、さらに対象オープンチャット名を含む通知だけに絞ります。アクションは HTTP POST にして、URLを次の形にします。

`https://claude-pc.tailc5d751.ts.net/api/line-ingest?t=パソコン側と同じ専用トークン`

本文形式は JSON、Content-Type は `application/json` にします。MacroDroid の通知変数を使って、次の5項目を送ります（変数名は端末のMacroDroid画面で「通知タイトル」「通知本文」「通知時刻」「アプリ名」に相当するものを選びます）。

```json
{"chat":"通知タイトル","sender":"通知の送信者","text":"通知本文","ts":通知時刻のミリ秒,"pkg":"jp.naver.line.android"}
```

HTTP ヘッダーを使う場合は URL の `?t=...` を外し、`Authorization` に `Bearer 専用トークン` を設定しても構いません。個人トークを送らないよう、MacroDroid側の絞り込みとパソコン側の allowlist の両方を必ず設定してください。

## 3. 動作確認する

認証と今月の保存件数を確認します。

```text
curl "https://claude-pc.tailc5d751.ts.net/api/line-ingest?t=専用トークン"
```

サンプル通知を保存し、ダイジェストを作ります。

```text
node line-digest.mjs --seed
```

ファイルを書き換えず予定だけ確認します。

```text
node line-digest.mjs --dry-run
```

未処理の提案を一覧表示します。

```text
node line-digest.mjs --list
```

確認済みの提案を完了にします（番号は一覧のものに置き換えます）。

```text
node line-digest.mjs --done P-0001
```

採用しない提案を却下します。

```text
node line-digest.mjs --reject P-0001
```

## 4. 夜間に自動実行する

Windows の「タスク スケジューラ」で毎晩1回、`node` を実行するタスクを作り、引数に line-digest.mjs のフルパスを指定します。「開始（オプション）」にはこのファイルがある `tools` フォルダーを指定します。最初は手動でタスクを実行し、下記の出力ファイルが更新されることを確認してください。

## うまくいかない時

- 取り込みデータ: `~/.claude/line-openchat/YYYY-MM.jsonl`。増えない場合は MacroDroid の実行履歴、URL、専用トークン、allowlist のチャット名を確認します。
- 処理位置: `~/.claude/line-openchat/state.json`。同じ通知を再処理しないための記録です。
- ダイジェスト: `~/.claude/ai-news-digest.md`。情報が短すぎる、あいさつだけ、重要度が低い場合は掲載されません。
- 提案一覧: `~/.claude/ai-news-proposals.jsonl`。
- AI利用実績: `~/.claude/executor-usage.jsonl`。401/403 はAPIキー、402は残高、429は利用上限を確認します。Groqが失敗するとDeepSeekへ切り替わります。
- `LINE_INGEST_TOKEN not configured` はパソコン側の専用トークン未設定、`Unauthorized` は端末とパソコンのトークン不一致です。
- `not-allowed` は `LINE_INGEST_ALLOW_CHATS` に通知タイトルと一致する名前がない状態です。
