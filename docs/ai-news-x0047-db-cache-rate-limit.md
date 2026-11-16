# X-0047: DBアクセスをキャッシュと制限で抑制 — スパイク検出＋総量ガードレール

**AIニュース提案 2026-11-15**: Supabase REST API へのクエリにファイルキャッシュ層を追加し、短時間スパイクの 429 検出と総スキャン 300万件上限のガードレールを実装。株式会社オージャストのイベント管理（auto-progress の channel_messages 照会）やブース予約サイトのバックエンドで従量課金増を防ぐ。

観測日: 2026-11-15
実装: `tools/supabase-guard.mjs` + `tools/supabase-guard.test.mjs`

---

## 1. 概要

Supabase（PostgREST）はクエリ1回につき SELECT の全行をスキャンする。このコストは:

- **Supabase Pro Plan** では 1 行あたりの従量課金はないが、**大量クエリ** が DB 負荷を上げ、コネクションプールを圧迫
- 短時間のスパイク（例: 5000行 × 20回 = 10万行/分）が定常負荷の 10 倍を超えると、DB インスタンスのスケールアップが必要に
- 放置すると月間数百万行のスキャンが常態化し、**本来不要だったデータ転送と待ち時間** が蓄積する

本提案はファイルキャッシュの導入と、スキャン件数の上限ガードレールを組み合わせて解決する。

## 2. 実装: `tools/supabase-guard.mjs`

### 2.1 3層の保護

| 層 | 機構 | 効果 |
|----|------|------|
| **キャッシュ** | 同一クエリの結果をファイルに保存 (TTL 1分〜) | 短周期の重複クエリを排除 |
| **スパイク検出** | 1分窓のスキャン行数を追跡、閾値超過で 429 | 突発的な大量取得を阻止 |
| **総量ガードレール** | 累計スキャン行数が 300万超で AI 作業停止 (503) | 実行計画なしの無制限スキャンを防止 |

### 2.2 キャッシュ設計

キャッシュキーはテーブル名 + クエリパラメータのソート済み JSON を SHA-256 でハッシュ:

```js
export function cacheKey(table, params) {
  const input = `${table}|${JSON.stringify(params, Object.keys(params).sort())}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}
```

キャッシュは JSON ファイルとしてディスクに保存され、TTL 経過後は自動無効化。古いキャッシュはエントリ数 1000 件を上限に LRU 的に削除される。

### 2.3 スパイク検出

スパイクは固定窓（デフォルト 60 秒）で行数をカウントし、閾値（デフォルト 10 万行/分）超過時に 429 エラーを返す。

```js
function checkLimits(estimatedRows, now) {
  refreshWindowIfNeeded(now);
  if (state.windowRowCount + estimatedRows > maxRowsPerWindow) {
    const err = new Error(`Supabase スキャンスパイク検出`);
    err.statusCode = 429;
    err.code = 'SPIKE_DETECTED';
    throw err;
  }
}
```

窓が変わるとカウントは自動リセットされるため、一時的なバースト後は正常に戻る。

### 2.4 総量ガードレール

全期間の累積スキャン行数が 300 万件を超えると、以降すべてのクエリが 503 で拒否される。これはリセットでのみ解除可能で、「気付かないうちにスキャンし続ける」を防止する。

### 2.5 既存コードとの互換性

`rawFetch()` メソッドは Response オブジェクトを返すため、既存の `fetchImpl` と置き換え可能:

```js
// 変更前
const r = await fetchImpl(url, { headers: sbHeaders(secrets) });

// 変更後
const guard = createSupabaseGuard({ url: secrets.SUPABASE_URL, key: secrets.SUPABASE_SERVICE_ROLE_KEY });
const r = await guard.rawFetch(url, { /* headers は自動付与 */ });
```

## 3. 適用ケース

### 3.1 イベント管理: `auto-progress-external-check.mjs`

LINE メッセージの新着照会は `channel_messages` テーブルに対して 500 行ずつページングする。以下の状況で効果を発揮:

- 10秒間隔のポーリング → キャッシュが同一クエリの再取得を回避
- イベント前日の大量メッセージ → スパイク検出が DB 負荷を制限
- 複数のイベント同時監視 → 総量ガードレールが実行計画外の拡大を防止

### 3.2 ブース予約サイト (event-shop)

ブース予約の在庫確認・申込照会は短時間に多数の SELECT が走る。キャッシュ層で同一在庫クエリの再取得を排除し、予約ラッシュ時のスパイク 429 で DB を保護する。

## 4. 設定とチューニング

環境変数または `createSupabaseGuard()` の引数で調整可能:

| パラメータ | 環境変数 | 既定値 | 推奨値 |
|-----------|---------|--------|--------|
| キャッシュTTL | `SUPABASE_GUARD_CACHE_TTL_MS` | 60000 (1分) | 30000 (30秒)〜300000 (5分) |
| スパイク窓 | `SUPABASE_GUARD_SPIKE_WINDOW_MS` | 60000 (1分) | 60000〜300000 |
| 1窓あたり最大行数 | `SUPABASE_GUARD_MAX_ROWS_PER_WINDOW` | 100000 | 50000〜500000 |
| 総スキャン上限 | `SUPABASE_GUARD_MAX_TOTAL_ROWS` | 3000000 | 1000000〜10000000 |

## 5. 類似事例との比較

| アプローチ | コスト | 効果 | 欠点 |
|-----------|-------|------|------|
| Supabase Query Plan 最適化 | 0 | 恒久的に効く | アプリ改修が必要 |
| Supabase Read Replica | $50/月〜 | スケールアウト | 短期的スパイクに弱い |
| **本提案 (キャッシュ+ガード)** | **0 (ファイルI/Oのみ)** | **スパイク吸収＋上限停止** | **キャッシュが古い可能性** |
| アプリケーション側バッファリング | 開発工数大 | 実装次第 | 複雑性増加 |

**コストパフォーマンス**: ファイル I/O のみで従量課金が発生しない。導入コスト 0、維持コスト 0 で 300万件以上の無駄なスキャンを防止可能。

## 6. 残課題

- [ ] `supabase-guard.mjs` の全ツールへの展開 (auto-progress-external-check.mjs 等)
- [ ] 長期運用でのキャッシュディスク使用量監視
- [ ] Supabase Query Stats との突き合わせによる閾値自動調整