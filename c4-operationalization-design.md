# C4（fallback_chain_timeout 監視）実運用化デザイン

**作成**: 2026-10-30T08:28 JST / 状態: **デザイン確定・kim 承認待ち**
**プロジェクト**: quota-sweep / C4 criterion checker 実運用化

---

## Objective

C4（fallback_chain_timeout 基準）を、`_c4_check.mjs` で観測できるだけでなく、実運用のクォータスイープループに組み込み、異常を自動検出・通知・記録するまでを完成させる。

**C4 の定義（`_c4_check.mjs` より）**:
1. `delegation-health.json` の `generatedAt` が 2026-10-30T03:25 JST 以降であること
2. `delegation-health.json` に `fallback_chain_timeout` の findings が無いこと
3. `executor-usage.jsonl` の24時間窓の fallback+timeout 行が2未満であること

**現状（2026-10-30T08:28 JST 実測）**:
- ✅ delegation-health.json: fallback_chain_timeout の finding は **0件**（PR #1237 の修正が効いている）
- ✅ executor-usage.jsonl: 24h fallback+timeout = **0件**
- ❌ delegation-health.json の generatedAt（2026-10-30T02:05 JST）がエポック（03:25 JST）より前 → 次回のスイープセッションで自動更新されれば解決する見込み
- **実質的な健全性は担保されている**（0件 timeout, 0件 finding）

---

## Design

### 1. Observer（観測者）

**決定: 巡回型（スイープループ統合）**

既存の quota-sweep loop は ~15分間隔で RemoteTrigger 起動されている。`_c4_check.mjs` をスイープ冒頭で実行し、結果をログに記録する設計とする。

**根拠**:
- 常時バックグラウンドプロセスは Windows 環境で維持コストが高い（プロセス監視・死活再起・ログ肥大の面倒を見る必要がある）
- スイープループは既存の ~15分間隔で起動しており、監視のリアルタイム性に十分
- 常時プロセスの追加は「後で別アカウントへ管理を移す」移管前提設計に反する（外部リソースの増加）

**トレードオフ**: 最大 ~15分の検出遅延が発生するが、fallback_chain_timeout は数秒から数分で完了する事象であり、検出が15分遅れても実害は無い。

### 2. Observation method（観測方法）

**決定: `_c4_check.mjs` をスイープエントリポイントから呼ぶ。GAS は使わない。**

**理由**:
- `_c4_check.mjs` は既に実装済み（161行、安定して動作）
- 観測対象はローカルファイル（`delegation-health.json`、`executor-usage.jsonl`）であり、GAS 経由にする意味が無い
- GAS 化はメンテナンスコストが増えるだけ（同期・認証・デプロイ）

**統合方法**: スイープエントリ（例: `quota-sweep.mjs` または auto-session の起動スクリプト）が `_c4_check.mjs` を呼び、結果を `quota-sweep.jsonl` に追記する。

### 3. Notification destination（通知先）

**決定: kim の Discord DM（既存 `notify-kim.mjs` 経路）**

**根拠**:
- `dispatch-work.mjs` は存在しない（調査済み）
- kim-PC の Discord チャンネルという概念は無く、Discord の DM が最適
- `notify-kim.mjs` は既に動作実績があり、Discord Bot トークンも配置済みで動作確認済み（ファイル実在）
- 2回目のC4違反からは24時間抑制（`notify-kim.mjs` の重複防止機構）が働く

**閾値違反時の通知内容**:
- C4 違反の種別（delegation-health の閾値未達 / fallback_chain_timeout 検出 / 24h timeout 超過）
- 実測値と閾値
- 自動起票された next-session.md の TODO（原因調査・修復）

### 4. Threshold（閾値）

**決定（既定値）**:

| パラメータ | 既定値 | 根拠 |
|---|---|---|
| C4 エポック | `2026-10-30T03:25:00+09:00` | 最終修正（PR #1237）の反映確認日時。変更不要 |
| 24h fallback+timeout 閾値 | `< 2` | 直近の実績（最大3段・約24秒）から、偶発的な1件は許容するが2件以上は異常と判断 |
| 通知抑制期間（重複防止） | 24時間 | `notify-kim.mjs` 既定の same-source-cause-24h |

**変更可能性**: `_c4_check.mjs` は `--threshold` 引数（未実装だが設計上は渡せる）で閾値変更可能にするのが望ましいが、現状のハードコード値（`C4_TIMEOUT_THRESHOLD = 2`）で十分。閾値調整が必要な場合は `_c4_check.mjs` を直接編集する（年に1度あるかどうかの操作）。

### 5. Auto-response（自動対処）

**決定: C4 違反検出 → `notify-kim.mjs` で通知 + `next-session.md` に修復TODOを自動起票**

**フロー**:
```
C4 check fail
  → _c4_check.mjs exit 1
  → 起動元（quota-sweep エントリ）が検出
  → notify-kim.mjs 経由で kim に DM 通知
  → next-session.md に修復TODOが自動起票される（notify-kim.mjs の内蔵ロジック）
  → 次回スイープでそのTODOを拾い、原因調査→修正→再検証のサイクルに入る
```

**C4 違反が起きてもスイープ自体は継続する**（異常検出でループ停止はしない。ただし修復TODOが積まれる）。

**main rescue 起動は行わない**:
- fallback_chain_timeout 単体では全停止には至らない（他のレーンは動き続ける）
- 全レーン停止は別指標（例: `lane_outage_unrepaired`）で検出される範囲
- main rescue に必要なコード枠組みがまだ無い（ゼロからの設計になるため先送り）

---

## Implementation Plan

### Phase 1: C4 スイープ統合（所要見積: 60分）

| # | タスク | ファイル | 内容 |
|---|---|---|---|
| 1 | スイープエントリで C4 を呼ぶ | `quota-sweep.mjs` または既存の auto-session 起動スクリプト | `_c4_check.mjs` を `--json` モードで実行し、結果を `quota-sweep.jsonl` に追記 |
| 2 | C4 違反時の通知 | `notify-c4-failure.mjs`（新規、または既存スイープに内蔵） | `_c4_check.mjs` の exit code が 1 の場合、`notify-kim.mjs` の `notifyKim()` を呼び出す |
| 3 | テスト | `_c4_check.test.mjs`（新規） | 異常系（ファイル不在・パース失敗・threshold 超過）・正常系（全件pass）のテスト |
| 4 | このデザインを memory に保存 | `memory/c4-operationalization-design.md` | 設計判断の経緯を記録 |

### Phase 2: 動作確認・検証（所要見積: 30分）

| # | タスク | 内容 |
|---|---|---|
| 5 | 手動実行 | `node tools/_c4_check.mjs --json` を実行し、結果を確認 |
| 6 | 通知テスト | 強制違反状態を作って notify-kim 経路を確認（dry-run） |
| 7 | 24h 抑制テスト | 2回連続通知が抑制されることを確認 |

### Phase 3: 自動化（所要見積: 30分 + 翌日検証）

| # | タスク | 内容 |
|---|---|---|
| 8 | スイープループに統合 | RemoteTrigger /.claude の cron 的な設定（既存のスイープ起動に組み込む） |
| 9 | 翌日 C4 エポック通過 | `delegation-health.json` の generatedAt が 03:25 JST 以降に更新され、C4 が PASS することを確認 |

### 未着手（フェーズ外）
- main rescue スキーム（全レーン異常時の強制回復）→ 別案件として設計が必要
- `_c4_check.mjs` の `--threshold` 動的引数（必要になるまで追加しない）

---

## Test Plan

### 動作確認手順

```
# 1. C4 正常系
node tools/_c4_check.mjs
  → exit 0, "✅ PASS"

# 2. C4 異常系（強制的に違反状態を作る）
#   delegation-health.json に fallback_chain_timeout を追加してから
node tools/_c4_check.mjs
  → exit 1, "❌ FAIL", "hasFallbackTimeout=true"

# 3. ファイル不在
mv ~/.claude/delegation-health.json ~/.claude/delegation-health.json.bak
node tools/_c4_check.mjs
  → exit 2, "FATAL: ..."
mv ~/.claude/delegation-health.json.bak ~/.claude/delegation-health.json

# 4. JSON 出力モード
node tools/_c4_check.mjs --json
  → JSON が標準出力へ（パース可能なこと）
```

### 通過条件
- [ ] 全テストケースで exit code が設計通り
- [ ] 正常系 3 回連続で ✅ PASS
- [ ] 通知経路の実動作確認（kim の Discord DM に届くこと）

---

## Q&A

| 未確定判断 | このデザインでの決定 | 代案・根拠 |
|---|---|---|
| Q1. 常時監視 vs 巡回監視 | 巡回（スイープループ統合） | 常時は移管前提に反する + Windows で維持コスト高 |
| Q2. GAS 化 vs ローカル | ローカル（`_c4_check.mjs`） | 観測対象がローカルファイルのみ。GAS 化のメリット無し |
| Q3. 通知先 | Discord DM（notify-kim） | dispatch-work.mjs は存在しない。既存の最も安定した経路 |
| Q4. 閾値 | 24h < 2, エポック固定 | 実績値ベース。現状の 0件 に対し 2 は安全余裕あり |
| Q5. main rescue 連動 | しない（単独異常） | main rescue スキームはコード枠組みが無い。別案件 |

**kim に確認してほしい判断**:
1. 通知先は Discord DM でよいか（dispatch-work.mjs のような専用チャンネルが不要であれば）
2. main rescue 起動は必要になった時点で設計でよいか
3. スイープループ統合の優先度（今すぐ実装すべきか、次週のスイープ improvement でよいか）

---

## 添付

- `tools/_c4_check.mjs` — 現状実装（161行・2026-10-30 01:09 commit `a9fcae3`）
- `~/.claude/quota-sweep.jsonl` — スイープ実績ログ（C4 統合先）
- `~/.claude/quota-sweep.log` — スイープ状態ログ

---

*このデザインは 2026-10-30T08:28 JST 時点の調査結果に基づきます。dispatch-work.mjs は orgiast-claude-rules と nightly-repo のいずれにも存在しませんでした。*