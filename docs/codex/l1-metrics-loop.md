# L1 Metrics Loop

<!-- lane: sol -->

## 目的
L0（30秒ループのquota-sweep）とは別に、2時間間隔で全AIの使用率・支出・枯渇予測を収集し、CSVに蓄積する。統計は `delegation-health` や `cost-report` が参照できる形で保存する。

## 完了条件
1. `node tools/l1-metrics-loop.mjs` が 2時間間隔 x 6並列で動作し、各走行で `used_percent` + `spend` + `depleted_at`（残日数）をCSVに追記する
2. **AI別に** 収束（24時間変化なし）・枯渇（残0.5日未満）・警告（残3日未満）のタグをフィルタした最新状態を保存する
3. 前回比を出し、異常値（前回比10倍以上 / データ消失 / 残日数が異常に増加）を検出してログに残す
4. `node --test tools/*.test.mjs` が緑

## 既存の仕組み（これを使う／説明）

### データソース
- **`~/.claude/executor-usage.jsonl`**: プロバイダごとのspend情報。各行: `{t, provider, in/out/tokens/secs, model, ...}`。`C:\Users\user\.claude\executor-usage.jsonl` を読む。既存の読み取りパターンは `tools/delegation-health-check.mjs` の `readJsonl`。
- **`~/.claude/quota-sweep.jsonl`**: quota-sweep実行ごとの消費率。行: `{ts, provider, outcome, beforeUsedPercent, afterUsedPercent, ...}`。読み取りは `tools/quota-sweep.mjs` の `read()` / `json()`。
- **`~/.claude/quota-claude-window-cache.json`**: Claude API枠のキャッシュ。`tools/lib/quota-windows.mjs` の `readClaudeWindows()` が最新値を取得するAPIラッパー（OAuth usage API）。
- **Codexのセッションログ**: `~/.codex/sessions/` 以下の最新JSONL。`tools/lib/quota-windows.mjs` の `readCodexWindows()` でパースする（`rate_limits.primary/secondary`）。

### 既存のユーティリティ
- `tools/lib/quota-windows.mjs`: `readClaudeWindows()`, `readCodexWindows()`, `decideSweep()`, `shouldStopTick()`
- `tools/delegation-health-check.mjs`: `readJsonl()`, `readJson()`, `windowResetsAfterLimit()`, `dedupeLimitEvents()`
- `tools/cheap-code.mjs`: `resolveProvider()` で provider 定義を取得

### AIアカウント一覧（executor-usage.jsonlから動的に抽出）
executor-usage.jsonl の `provider` フィールドから全プロバイダを抽出する。固定リストは使わない（追加・削除に追随するため）。

## ファイル構成（新規作成）
```
tools/
  l1-metrics-loop.mjs    # メインループ
  l1-metrics-loop.test.mjs  # テスト
  lib/l1-metrics.mjs     # 計測ロジック（純粋関数＋ファイルI/O）
```

## 設計詳細

### 1. データ収集 (`collectMetrics`)

**入力**: なし（`~/.claude/` のファイルを読む）

**出力**: `{ ts: ISO, source: string, usedPercent: number|null, spend: number|null, depletedAt: number|null, provider: string, ai: string }[]`

**手順**:
1. `readClaudeWindows()` で Claude の5h/7d枠を取得 → `source: 'claude-5h'`, `source: 'claude-7d'`
2. `readCodexWindows()` で Codex のprimary/secondary枠を取得 → `source: 'codex-primary'`, `source: 'codex-secondary'`
3. `executor-usage.jsonl` から直近24時間の行を集計して provider 別の spend（in+out tokens相当の cost estimate）を計算
   - 同一 provider の行を groupBy → sum(tokensOut + tokensIn) → 料金換算（`tools/provider-routing.mjs` の `gatewayModel` 参照、なければ 1M tokens = $3 で概算）
4. `quota-sweep.jsonl` から各 provider の最新 beforeUsedPercent を取得
5. `depletedAt` の計算: spend が過去24時間の平均消費速度から残日数を算出。`usedPercent` が100%に達する時刻。spend が 0 または欠損なら null にする。

**注意**: 各ファイルの読み取りは `JSON.parse` のエラーを個別に catch し、1ファイルの破損で全体が止まらないようにする。quota-sweep.jsonl は複数行なので `split('\n').flatMap(line => { try ... })` パターン（`delegation-health-check.mjs:readJsonl` と同様）。

### 2. CSV追記 (`appendCsv`)

**CSVの場所**: `~/.claude/metrics/l1-metrics.csv`

**フォーマット**:
```csv
ts,source,used_percent,spend,depleted_at,provider
2026-10-31T12:00:00Z,claude-5h,45.2,12.34,15.5,claude
```

**ルール**:
- ファイルが無ければヘッダ行を書き込んでから追記
- 追記は atomic write（tmpファイル→rename）で行う
- 既存の行を読み直さない（append only）

### 3. AI別タグ付け (`tagMetrics`)

**入力**: 直近の全CSV行

**出力**: `{ ai: string, usedPercent: number|null, depletedAtDays: number|null, tag: 'converged'|'starving'|'warning'|'normal', spend24h: number }[]`

**タグ条件**:
| タグ | 条件 |
|------|------|
| `converged` | 直近24時間（同source）の usedPercent 変化が ±1% 未満 |
| `starving` | depletedAt < 0.5 日 |
| `warning` | 0.5日 <= depletedAt < 3 日 |
| `normal` | 上記以外 |

**注意**: `usedPercent` または `depletedAt` が null の場合はタグを付けず `unknown` とする。複数タグ条件に合致する場合は最も深刻な方を優先: `starving` > `warning` > `converged` > `normal`。

**保存先**: `~/.claude/state/l1-metrics-tags.json`
```json
{
  "updatedAt": "2026-10-31T12:00:00Z",
  "ais": [
    {"ai": "claude-5h", "usedPercent": 45.2, "depletedAtDays": 15.5, "tag": "normal", "spend24h": 12.34}
  ]
}
```

### 4. 異常検出 (`detectAnomalies`)

**入力**: `{ previous: { usedPercent, spend, depletedAt, provider, source }, current: { same fields } }`

**出力**: `{ level: 'warn'|'error', message: string, provider: string, source: string }[]`

**検出条件**:
- **前回比10倍以上**: `current.spend > previous.spend * 10 && previous.spend > 0` → `level: 'warn'`
- **データ消失**: 前回あった source が今回ない → `level: 'error'`
- **残日数が異常に増加**: `current.depletedAt > previous.depletedAt * 2 && previous.depletedAt > 0` → `level: 'warn'`（リセット後の正常な増加は除くため、`current.usedPercent < previous.usedPercent` のときは警告しない）
- **usedPercent 急増**: `current.usedPercent - previous.usedPercent > 50` → `level: 'error'`

前回値が存在しない（初回）場合は空配列を返す。

**保存先**: `~/.claude/state/l1-metrics-anomalies.jsonl`（追記）

### 5. メインループ (`l1-metrics-loop.mjs`)

**起動**: `node tools/l1-metrics-loop.mjs [--interval 120] [--pods 6] [--once] [--json]`

**引数**:
- `--interval N`: 実行間隔（分、既定120）
- `--pods N`: 並列数（既定6）
- `--once`: 1回だけ実行して終了
- `--json`: JSON出力（stdout）

**ループ制御**:
1. 起動時に `.loop/l1-metrics.guard` を touch（プロセス重複防止）
2. 定周期（interval分）で `collectMetrics → appendCsv → tagMetrics → detectAnomalies` を実行
3. 異常があれば stderr に出力
4. 各サイクル終了時にタグ状態を stdout（または `--json` 時は JSON）
5. `SIGINT`/`SIGTERM` で graceful shutdown（現在のサイクルを完了して終了）

**初回実行**: ループに入る前に1回 `--once` 相当の収集を行う。

**ポッド**: 並列数は1プロセス内の非同期で処理する（子プロセスは起動しない）。6ポッド = 6個のデータソースを同時にqueryする。

### 6. L0との衝突回避

quota-sweep（L0）も同じファイルを読み書きする可能性がある。以下の対策をとる:
- **読み取り**: `fs.readFileSync` の結果を即座に `JSON.parse`。部分書き込み中はパースエラーになるが、個別catchでスキップ（次回で再取得）
- **書き込み**: `writeFileSync(tmp) → renameSync(tmp, target)` の atomic pattern（`quota-sweep.mjs` の `atomic()` 関数と同様）
- **ロック**: 共有ファイルへの同時書込みは起こらない設計にする（L0はquota-sweep.jsonl / L1はl1-metrics.csvでファイルが分かれている）

## 実装順序
1. `tools/lib/l1-metrics.mjs` — collectMetrics, appendCsv, tagMetrics, detectAnomalies（純粋関数+ファイルI/O）
2. `tools/l1-metrics-loop.mjs` — メインループ、引数パース、シグナルハンドリング
3. `tools/l1-metrics-loop.test.mjs` — 各関数のテスト（既存テストと同様に `node --test` で動く）
4. `node --test tools/l1-metrics-loop.test.mjs` が通ることを確認
5. `node tools/l1-metrics-loop.mjs --once` で実動作確認

## 禁止事項
- L0（quota-sweep）のループ制御を変更しない
- 既存のJSONLフォーマットを変更しない（追記のみ）
- 外部API（Discord, Slack, Gmail）への通知は行わない
- `push` / `PR` / `merge` は行わない
- `git` 操作で新規ファイルのステージング以外は行わない

## 既存コードからの引用パターン

### JSONL読み取り（delegation-health-check.mjs）
```js
function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; }
}
```

### atomic書き込み（quota-sweep.mjs）
```js
const atomic = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
};
```

### CSV追記
```js
function appendCsv(file, row) {
  const header = 'ts,source,used_percent,spend,depleted_at,provider\n';
  const exists = fs.existsSync(file);
  const tmp = `${file}.${process.pid}.tmp`;
  if (!exists) fs.writeFileSync(tmp, header + row + '\n');
  else fs.writeFileSync(tmp, row + '\n'); // writeFileSyncが0バイトで始める
  fs.renameSync(tmp, file);
}
```
注意: appendは `fs.writeFileSync(tmp, ..., { flag: 'a' })` ではなくtmp→renameのatomicにする。

### Claude window取得
```js
import { readClaudeWindows, readCodexWindows } from './lib/quota-windows.mjs';
const claudeWindows = await readClaudeWindows({ home: os.homedir() });
const codexWindows = readCodexWindows({ home: os.homedir() });
```