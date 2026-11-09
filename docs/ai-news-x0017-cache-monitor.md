# X-0017: キャッシュ監視で20倍コスト増を防止

> **AIニュース提案 X-0017**: Claude Code セッションのプロンプトキャッシュ残り時間を監視し、ステータスバーに表示する。キャッシュが切れそうなら自動的に短い ping を予約し、キャッシュTTL(5分)を維持することで、毎回コンテキストを詰め直す20倍コスト増を防止する。
>
> 観測日: 2026-11-10

## 1. 課題

Slack の 20 分チャンネル監視 bot が、大量のチャンネルを一気に見る際に全コンテキストを新しく詰め直すため、毎回プロンプトキャッシュが start new になり、**20倍のコスト**になっている。

同様の問題は長時間セッション全般で発生する:
- イベント企画の長セッションでキャッシュが切れるたびに全コンテキスト再送
- ポーリング型の定期実行でキャッシュが維持されず毎回フルコスト

## 2. 解決策

### 2.1 キャッシュTTL監視

Anthropic のプロンプトキャッシュ TTL は **5分(300秒)**。最後のツール呼び出しから5分以内に次の呼び出しが無いとキャッシュは破棄され、次回は全コンテキストの再送（≒20倍コスト）になる。

`tools/cache-monitor.mjs` はこの残り時間を追跡する:

- `--status`: キャッシュ状態を JSON 出力（TTL残り秒、メモリ使用量、サブスク種別、ping予約状態）
- `--statusline`: ステータスバー用1行を出力（`🅲 TTL:4m30s 📊61MB 🅿25m`）

### 2.2 自動キャッシュ維持 (ping)

キャッシュTTLが切れそうな時、軽量な ping 操作でキャッシュを維持する:

1. `--schedule-ping`: 現在時刻 + 25分(1500秒) の予約時刻を計算し、state.json に保存
2. CronCreate で 25分後に `cache-monitor.mjs --ping` を実行
3. `--ping`: state.json の `lastActivityAt` を現在時刻に更新（軽量ファイル書き込みのみ）
4. この ping によりキャッシュTTLがリセットされ、次の25分延命

**50分周期**: ping は 25分後に発火し、TTLを5分リセット → 合計 30分延命。次の ping 予約までの 20分バッファがある。

### 2.3 タイマーの冪等性

- 新しい ping を予約するとき、古いタイマーは CronDelete で確実に削除
- state.json に `pingScheduledAt` を記録し、常に最新の1件だけが有効

### 2.4 セッションクローズ時の後片付け

- `/cache-cancel` スラッシュコマンド相当で予約を解除
- セッション終了時に CronDelete でタイマーを削除

## 3. アーキテクチャ

```
                    ┌─────────────────────────────┐
                    │    SessionStart hook         │
                    │  → cache-monitor --status    │
                    │  → ステータスラインに表示     │
                    └──────┬──────────────────────┘
                           │ TTL < 45秒 検知
                           ▼
                    ┌─────────────────────────────┐
                    │  自動 ping 予約              │
                    │  cache-monitor --schedule-ping│
                    │  CronCreate(at: +25min)     │
                    │  (+ CronDelete で旧削除)     │
                    └──────┬──────────────────────┘
                           │ 25分後
                           ▼
                    ┌─────────────────────────────┐
                    │  ping 発火                   │
                    │  cache-monitor --ping        │
                    │  → lastActivityAt更新        │
                    │  → キャッシュTTL リセット     │
                    └─────────────────────────────┘
```

## 4. 使い方

```bash
# キャッシュ状態確認
node tools/cache-monitor.mjs --status
# → {"cacheTtlSec":180,"cacheExpired":false,"subscription":"pro","memoryMb":61,"ping":{"nextAt":"...","intervalSec":1500},"timestamp":"..."}

# ステータスバー用
node tools/cache-monitor.mjs --statusline
# → 🅲 TTL:3m0s 📊61MB 🅿25m

# キャッシュ維持ping
node tools/cache-monitor.mjs --ping
# → {}

# 25分後にping予約
node tools/cache-monitor.mjs --schedule-ping
# → {"at":"2026-11-10T12:00:00.000Z"}

# 予約取消
node tools/cache-monitor.mjs --cancel-ping
# → {"cancel":true}
```

## 5. 状態ファイル

`~/.claude/cache-monitor/state.json`:

```json
{
  "lastActivityAt": "2026-11-10T11:35:00.000Z",
  "pingScheduledAt": "2026-11-10T12:00:00.000Z",
  "pingIntervalSec": 1500
}
```

- `lastActivityAt`: 最後のツール呼び出し/ ping 時刻
- `pingScheduledAt`: 次の ping 予約時刻（予約が無いときは null）
- `pingIntervalSec`: ping 間隔（固定 1500秒 = 25分）

## 6. 拡張アイデア

- ステータスバー表示のための SessionStart hook 自動登録
- `/cache-status` スラッシュコマンド化
- TTL 激減の初回検知時だけ notification を出す
- 複数セッション間でキャッシュ状態を共有（同一マシン）
- キャッシュヒット率の常時監視と閾値警告（50% / 20%）