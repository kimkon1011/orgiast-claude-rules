# L0 3ランナー状態確認とレーン別 resource 解決案

> 作成: 2026-11-01 / セッション: quota-sweep/20261031-1618-claude-mvwlvp3o / epic/l1-quota-sweep-3-runners

## L0-1: quota-sweep-claude の resource 使用量と制約

### エントリポイントと起動方法

- **`quota-sweep --claude` → `tools/quota-sweep.mjs`** がエントリポイント
- Claude Code SDK (`claude -p`) を子プロセスとして呼び出す
- 子プロセスのモデルは環境変数 `ORGIAST_QUOTA_SWEEP_MODEL` で指定可能、既定は `sonnet`

### コード上のプロバイダ構成

`quota-sweep.mjs` は現状 **2プロバイダ** のみサポート:

| プロバイダ | 識別子 | 窓管理 | 実行環境 |
|-----------|--------|--------|---------|
| Claude API | `claude` | 5h / 7d の2窓 | Windows ネイティブ Claude Code |
| Codex (OpenAI) | `codex` | primary / secondary の2窓 | 同梱の codex.exe（WSL経由可） |

（参照: `tools/quota-sweep.mjs` `parseArgs()` L157-170, `decideSweep()` in `tools/lib/quota-windows.mjs` L97-118）

### 各窓の制約パラメータ

| パラメータ | 値 | コード上の定数 |
|-----------|-----|--------------|
| ハードシーリング | 97% | `hardCeilingPercent = 97` (quota-windows.mjs:92) |
| 最小残り% | 15% | `minRemainingPercent = 15` (quota-windows.mjs:97) |
| リード時間 | 90分 | `leadMinutes = 90` (quota-windows.mjs:97) |
| クッション時間 | 3分 | `marginMinutes = 3` (quota-windows.mjs:97) |
| 最低実行時間 | 10分 | `minRunMinutes = 10` (quota-windows.mjs:97) |
| 最大 tick 数 | 8 | `MAX_TICKS = 8` (quota-sweep.mjs:19) |
| 窓読取り TTL | 15秒 | `ttlMs = 15_000` (quota-sweep.mjs:187) |
| 429 Retry-After 上限 | 10分 | `RETRY_AFTER_CAP_MS = 10 * 60_000` (quota-sweep.mjs:207) |
| 429 再試行間隔 | 2s → 15s → 30s | `windowReadRetryDelaysMs` (quota-sweep.mjs:467) |
| 窓キャッシュ最大経過 | 10分 | `cacheMaxAgeMs = 10 * MINUTE` (quota-windows.mjs:70) |

### 連続失敗停止

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| 連続失敗閾値 | 3回 | `threshold = 3` (quota-sweep.mjs:50) |
| 停止理由 | `final`, `no-goal` はリセット | `sweepFailureStop()` (quota-sweep.mjs:50-60) |
| 失敗とみなす | `failed`, `exhausted`, `deadline`, `ceiling` | 同上 |
| deferred は非終端 | 回数カウントのみ | `queueRepeatedDeferral()` (quota-sweep.mjs:354-367) |

### 課金制約（budget-fixed.json）

| 項目 | 月額 | 備考 |
|-----|-------|------|
| 月額予算 | 150,000円 | usdJpy=150 |
| Claude Team seats | 未記入 | kim 記入待ち |
| ChatGPT (Codex) | 未記入 | - |
| Z.ai GLM | $12.6/月 | - |
| Cursor Pro | $20/月 | 2026-09-17 契約 |
| Gemini autopay | 20,000円/月 | cap（上限であって確定額ではない） |

## L0-2: 他のランナー（gemini/deepseek）が提供する resource

**結論: コード上で gemini/deepseek は quota-sweep のプロバイダとして未実装。** 
ただし、同一リポジトリ内で provider 抽象化の基盤（`llm-ask.mjs`, `provider-balance.mjs`, `provider-ratelimit-probe.mjs`）が整っている。

### 各ランナーの実態

| ランナー | 稼働PC | 時間帯 | AIバックエンド | quota-sweep上での扱い |
|---------|--------|-------|---------------|---------------------|
| quota-sweep-claude | つくばPC | US時間帯 | Claude API | `--provider claude` で実行 |
| quota-sweep-gemini | w018 PC | 西ヨーロッパ | Gemini API | **現状、未実装** |
| quota-sweep-deepseek | 韓国PC | 東アジア | DeepSeek (OpenRouter) | **現状、未実装** |

### Gemini の resource

| 項目 | 詳細 |
|------|------|
| エントリポイント | `tools/gemini-budget-guard.mjs` — 予算ガード |
| 使用量記録 | `tools/gemini-usage-ledger.mjs` → `executor-usage.jsonl` に `provider: 'gemini'` |
| API エンドポイント | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| API キー | `GEMINI_API_KEY`（env / `~/.gemini/.env`） |
| 月額上限 | 20,000円/月（budget-fixed.json / kind: cap） |
| モデル | gemini-3.7-flash |
| コスト | input $0.75/M, output $3.75/M tokens（llm-fallback.mjs:23） |
| 制限の種類 | 従量課金 + autopay 上限。RPM/TPM レート制限あり（要調査） |
| 現状の利用 | `tools/llm-ask.mjs --provider gemini` 経由で調査・分類用途 |

### DeepSeek の resource

| 項目 | 詳細 |
|------|------|
| エントリポイント | `tools/deepseek-ask.mjs` — CLI ヘルパー |
| 経路 | OpenRouter 経由（`deepseek/deepseek-v4-flash`） |
| API キー | `OPENROUTER_API_KEY`（OpenRouter ウォレット） |
| 独立キー | `DEEPSEEK_API_KEY` もある（DeepSeek 直 API） |
| 課金 | OpenRouter ウォレット（autoTopUp 設定済み） |
| モデル | deepseek/deepseek-v4-flash |
| コスト | input $0.091/M, output $0.182/M tokens（llm-fallback.mjs:41） |
| Claude 比 | 約1/10〜1/20 のコスト |
| 現状の利用 | `tools/deepseek-ask.mjs` で分類・抽出など安価推論用途 |

### 共通 provider 基盤

| モジュール | 機能 |
|-----------|------|
| `tools/llm-fallback.mjs` | フォールバック連鎖（groq → glm → cerebras → genspark → openrouter → deepseek → gemini → grok → kimi） |
| `tools/provider-routing.mjs` | Kimi/DeepSeek/Mistral → OpenRouter 経由のゲートウェイルーティング |
| `tools/provider-ratelimit-probe.mjs` | レート制限のプローブ |
| `tools/provider-balance.mjs` | 残高チェック（DeepSeek/OpenRouter/Kimi/Genspark） |
| `tools/provider-catalog.mjs` | プロバイダカタログ（ID/ホスト/エイリアス） |

## L0-3: L1 実装に向けた resource 評価

### ギャップ分析マッピング

```
quota-sweep.mjs の現在地:
  decideSweep()        → claude(2窓) + codex(2窓)
  runSweep()           → provider 別実行 (claude = Claude Code / codex = codex.exe)
  main()               → provider リスト: ['claude', 'codex']
  parseArgs()          → --provider claude|codex|all
  
l1-metrics.mjs の現在地:
  collectMetrics()     → claude-5h, claude-7d, codex-primary, codex-secondary
                         (= 4ウィンドウ、gemini/deepseek は spend 集計のみで窓管理なし)
```

### ギャップ1: プロバイダ抽象化

quota-sweep の `decideSweep()` と `runSweep()` は `claude` と `codex` にハードコードされている。
L1 では以下の拡張が必要:

1. **provider 列挙の一般化**: `['claude', 'codex', 'gemini', 'deepseek']` を扱えるように
2. **窓読み取りの一般化**: 各プロバイダの resource 制約を共通インターフェース（`usedPercent` + `resetsAt`）にマッピング
3. **子プロセス起動の一般化**: claude/codex 以外の CLI 起動方法の統合

### ギャップ2: 各ランナーの resource 制約を窓モデルへ変換

| ランナー | 現状の制約 | 窓モデルへの変換案 |
|---------|-----------|------------------|
| quota-sweep-claude | Claude Plan 5h/7d | **現行通り** |
| quota-sweep-gemini | 月額20,000円上限 + RPM制限 | 日割り窓（例: 666円/日）＋ レート制限を second 窓に |
| quota-sweep-deepseek | OpenRouter 従量（autoTopUp） | 残高を窓％に換算（例: 残高/$10 = 100% → 消費で減少） |

### ギャップ3: 既存 L1 計測ループとの統合

既存の `l1-metrics.mjs` / `l1-metrics-loop.mjs` は正常動作している（PR #1349 でマージ済み）。
しかし収集する窓は `claude` + `codex` の4窓のみ。gemini/deepseek は `executor-usage.jsonl` に spend として記録されるが、窓利用率の追跡は無い。

### 推奨フェーズ

**Phase 1**: provider 抽象化（`decideSweep` と `runSweep` の一般化）
- `parseArgs()` に `--provider gemini` / `--provider deepseek` 追加
- 各 provider の窓読み取り関数をプラグイン的に登録できる仕組み
- 子プロセス起動の抽象化（claude exec / codex exec / generic LLM CLI）

**Phase 2**: 各ランナーの resource プローブ実装
- Gemini: `gemini-budget-guard.mjs` から日割り上限を取得し、autopay 残枠を窓％に変換
- DeepSeek: `provider-balance.mjs` から残高取得。OpenRouter 経由の場合はレート制限測定（`provider-ratelimit-probe.mjs`）
- 共通: 各プロバイダのレート制限を real-time で測定する拡張

**Phase 3**: L1 計測ループへの3ランナー統合
- `l1-metrics.mjs` の `collectMetrics()` に gemini/deepseek の窓追加
- タグ（starving/warning/converged/normal）を全ランナーで統一
- 異常検知（`detectAnomalies`）を全ランナーに拡張