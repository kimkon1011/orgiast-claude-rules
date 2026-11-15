# Beeper Relay

kim-PC（Tailscale IP）だけが持つ Beeper Desktop API への権限制御付き中継サーバー。
他のPC（008・014 など）の Claude Code が Beeper のトークンを持たずに「読む」「返信を送る（承認制）」を可能にする。

## アーキテクチャ

```
他PC (008/014)
  └── tools/beeper-relay-client.mjs
        │ トークン認証・権限制御
        ▼
kim-PC (100.73.174.121:23380)
  └── tools/beeper-relay-server.mjs
        ├── GET  /v1/accounts          → Beeper Desktop API（読み取り専用）
        ├── GET  /v1/chats?query=      → Beeper Desktop API（読み取り専用）
        ├── GET  /v1/chats/:id/messages → Beeper Desktop API（読み取り専用）
        ├── POST /v1/send              → reply-queue に enqueue（直接送信しない）
        └── GET  /v1/send/:queueId     → reply-queue 状態確認
              │
              ▼ (kim が承認)
        beeper-send.mjs → Beeper Desktop API（実際の送信）
```

### トークン・権限

- トークンは sha256(salt + ":" + token) のハッシュで `~/.claude/beeper-relay/clients.json` に保存
- 平文トークンは発行時に一度だけ表示される
- 権限: `read`（閲覧のみ） / `send`（送信依頼可）
- ネットワーク制限: LINE / Messenger / WhatsApp / Discord など

## セットアップ（kim-PC）

### 1. サーバー登録

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\register-beeper-relay.ps1
```

タスクスケジューラに `OrgiastBeeperRelay` が登録され、ログオン時に自動起動する。
5分間隔でプロセス生存確認し、落ちていたら再起動する。

### 2. 手動起動

```bash
node tools/beeper-relay-server.mjs --bind 100.73.174.121
```

環境変数:
- `BEEPER_RELAY_BIND` — バインドIP（既定 127.0.0.1、Tailscale IP を推奨）
- `BEEPER_RELAY_PORT` — ポート（既定 23380）

### 3. クライアント発行

```bash
# read のみ（pc008）
node tools/beeper-relay-server.mjs --issue pc008 --scope read

# read + send、LINE のみ（pc014）
node tools/beeper-relay-server.mjs --issue pc014 --scope read,send --networks line

# 全ネットワーク許可
node tools/beeper-relay-server.mjs --issue pc999 --scope read,send
```

出力されたトークンを各PCの管理者に渡す。

### 4. 失効

```bash
node tools/beeper-relay-server.mjs --revoke pc008
```

### 5. 一覧

```bash
node tools/beeper-relay-server.mjs --list
```

## 他PCでの使い方

### 1. トークン設定

トークンを環境変数かファイルに設定:

```bash
# 環境変数
export BEEPER_RELAY_TOKEN="発行されたトークン"

# またはファイル
echo "発行されたトークン" > ~/.claude/beeper-relay/token.txt
chmod 600 ~/.claude/beeper-relay/token.txt
```

### 2. サーバーURL設定

```bash
export BEEPER_RELAY_URL="http://100.73.174.121:23380"
```

### 3. チャット一覧

```bash
node tools/beeper-relay-client.mjs --chats
node tools/beeper-relay-client.mjs --chats "田中"
```

### 4. メッセージ取得

```bash
node tools/beeper-relay-client.mjs --messages <chatID> --limit 20
```

### 5. 送信依頼

```bash
echo "よろしくお願いします" > /tmp/body.txt
node tools/beeper-relay-client.mjs --send <chatID> --body-file /tmp/body.txt
# → queueID が返る
```

### 6. 送信状態確認

```bash
node tools/beeper-relay-client.mjs --status <queueID>
```

## アカウント一覧

```bash
node tools/beeper-relay-client.mjs --accounts
```

## セキュリティ

- Tailscale IP（100.x.x.x）以外へのバインドは禁止（0.0.0.0 はエラー）
- 全リクエストを `~/.claude/beeper-relay/audit.jsonl` に記録（平文トークンは記録しない）
- 送信は kim の承認（reply-queue 経由）が必要
- クライアント別レート制限: read 60回/分、send 10件/時
- クライアントのトークンは SHA-256 のソルト付きハッシュで保存

## 死活監視

既存の nightly-health / funnel-probe に以下を追加:

```bash
curl -s -o /dev/null -w "%{http_code}" http://100.73.174.121:23380/
# → 200 が返れば生存
```

## 制限

- Beeper Desktop API は kim-PC の localhost:23373 が必要
- 送信は直接できず、必ず reply-queue を経由し kim の承認が必要
- Discord MCP は置き換えない（既存の kim-PC 用 MCP は残す）
- メッセージの全文検索は未対応（Beeper API の制約）

---

## HANDOVER 追記

- Beeper Relay の中継サーバー（tools/beeper-relay-server.mjs）は kim-PC のタスクスケジューラ `OrgiastBeeperRelay` で管理。他のPCへ移管する場合は以下が必要:
  1. 移管先PCに Beeper Desktop をインストール・ログイン
  2. Beeper API トークンが account.db に存在することを確認
  3. `tools/register-beeper-relay.ps1` を実行しタスク登録
  4. Tailscale IP を確認し `BEEPER_RELAY_BIND` を設定
  5. 全クライアントに新しいサーバーURLを通知（keyserve 経由）
  6. 古いサーバーのクライアントはすべて失効（`--revoke`）
- `~/.claude/beeper-relay/clients.json` に全クライアントの設定（トークンハッシュ・権限・ネットワーク制限）がある
- 監査ログは `~/.claude/beeper-relay/audit.jsonl`
- 関連: [docs/beeper-relay.md](docs/beeper-relay.md)