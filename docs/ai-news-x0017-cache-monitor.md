# X-0017: キャッシュ監視で20倍コスト増を防止

**AIニュース提案 X-0017**: Claude Code のプロンプトキャッシュ残り時間を監視し、切れそうなタイミングで軽量pingを自動発行。TTL切れによる全キャッシュ無効化（最大20倍の入力コスト増）を防止する。

観測日: 2026-11-10

---

## 1. 課題

Claude Code のプロンプトキャッシュは最後のAPI呼出しから**5分（300秒）** で期限切れとなる。キャッシュが切れると次回のAPI呼出しで全プロンプトを再送信する必要があり、入力トークンコストが最大20倍に跳ね上がる。

長時間セッション（調査・コードレビュー・ファイル処理等）では、以下のパターンでキャッシュ切れが頻発する:
- ユーザーが考えている間のアイドル時間
- 外部APIの応答待ち
- ファイルの大規模処理の中断
- 夜間バッチ処理の隙間

**コストインパクト**:
| 状態 | Input Tokens（目安） | コスト比 |
|------|-------------------|---------|
| キャッシュヒット（〜90%削減） | 10K | 1倍（基準） |
| キャッシュミス（全量送信） | 200K | **20倍** |

Mark 20 / 1h = アラート対象

## 2. 解決策: キャッシュ監視ツール

`tools/cache-monitor.mjs` を導入し、キャッシュ残り時間を監視・可視化する。

### 2.1 ツール概要

```bash
# キャッシュ状態を JSON 出力
node tools/cache-monitor.mjs --status

# ステータスバー用の1行表示
node tools/cache-monitor.mjs --statusline

# 軽量ping（lastActivityAtを更新）
node tools/cache-monitor.mjs --ping

# ping予定時刻を計算（キャッシュ維持タイマー用）
node tools/cache-monitor.mjs --schedule-ping

# ping予約を解除
node tools/cache-monitor.mjs --cancel-ping
```

### 2.2 アーキテクチャ

```
~/.claude/cache-monitor/state.json
├── lastActivityAt: ISO文字列   ← ping() で更新
├── pingScheduledAt: ISO文字列   ← schedulePing() で設定
└── pingIntervalSec: 1500       ← 25分固定

ツール呼出し → cacheStatus()
  ├── cacheTtlSec: 残り秒数（300 - 経過時間）
  ├── cacheExpired: bool
  ├── subscription: "pro" | "hobby" | "unknown"
  ├── memoryMb: RSS メモリ使用量
  └── ping: { nextAt, intervalSec }
```

### 2.3 Cache TTL 計算ロジック

```
最終アクティビティ: lastActivityAt
経過時間 = now - lastActivityAt
TTL残り = max(0, 300秒 - 経過時間)
期限切れ = TTL残り <= 0
```

### 2.4 Ping機構

- **--ping**: state.json の `lastActivityAt` を現在時刻に更新するだけ（軽量ファイル書き込み）
- **--schedule-ping**: `pingScheduledAt` を「現在時刻 + 25分」に設定し、CronCreateの参照値とする
- **--cancel-ping**: `pingScheduledAt` を null にクリア

ping自体は**API呼出しを伴わない**（ファイル書き込みのみ）。キャッシュ維持に必要なのは「一度でもAPI呼出しがあればTTLがリセットされる」という性質を利用し、CronCreate で25分ごとに短いAPI呼出しを発行する想定。

### 2.5 エクスポート関数

```js
const {
  cacheStatus,       // → { cacheTtlSec, cacheExpired, subscription, memoryMb, ping, timestamp }
  cacheStatusLine,   // → "🅲 TTL:180s 📊42MB 🅿25m"
  ping,              // → {} (state更新)
  schedulePing,      // → { at: ISO文字列 }
  cancelPing,        // → { cancel: true }
  readState,         // → state object
  writeState,        // → undefined
  statePath,         // → "~/.claude/cache-monitor/state.json"
  CACHE_TTL_SEC,     // → 300
  PING_INTERVAL_SEC, // → 1500
} = require('./cache-monitor.mjs');
```

## 3. 使い方

### 3.1 手動確認

```bash
# ステータス確認
node tools/cache-monitor.mjs --statusline
# → 🅲 TTL:180s 📊42MB 🅿25m

# JSONで詳細
node tools/cache-monitor.mjs --status | jq .
```

### 3.2 CronCreate との連携（キャッシュ維持）

```js
// 25分後に ping を予約
const { at } = schedulePing();
// → { at: "2026-11-10T14:25:00.000Z" }

// CronCreate で at に ping を実行
// CronCreate --at <at> --command "node tools/cache-monitor.mjs --ping"
```

### 3.3 フック連携（PostToolUse）

各ツール呼出し後に `cache-monitor.mjs --ping` を実行することで、最後のアクティビティ時刻を常に最新に保つことができる（軽量ファイル書き込みのためオーバーヘッドは無視できる）。

本ツールは単体で動作する。実際のCronCreate登録・hook連携は本ツールの出力を参照して別の仕組み（CronCreate / hook-dispatch）が行う。

## 4. 状態ファイル仕様

`~/.claude/cache-monitor/state.json`:

```json
{
  "lastActivityAt": "2026-11-10T12:30:00.000Z",
  "pingScheduledAt": "2026-11-10T12:55:00.000Z",
  "pingIntervalSec": 1500
}
```

- すべての読み書きは **fail-open**（失敗しても exit 0）
- state ファイルが存在しない場合はデフォルト値（lastActivityAt=null, pingScheduledAt=null）で動作
- 並行セッションでの競合は想定しない（最後の書き込みが優先）

## 5. 拡張アイデア

- **ステータスバー常駐**: エディタやClaude Code CLIのステータスラインに `cacheStatusLine()` を表示
- **警告しきい値**: TTLが60秒以下で警告表示（`🅲 ⚠ TTL:30s`）
- **自動ping**: フックで各ツール呼出し後に自動ping
- **コスト集計**: キャッシュヒット・ミスの回数を記録し、コスト削減効果を可視化

## 6. 関連

- X-0015: 静的先頭配置でプレフィックスキャッシュ最大化
- X-0016: プレフィックスキャッシュによるKV共有でメモリ・コスト削減
- X-0019: 長期セッション圧縮でキャッシュ保持71%コスト減