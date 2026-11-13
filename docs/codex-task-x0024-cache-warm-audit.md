# Codex 実装指示: tools/cache-warm-audit.mjs（X-0024 キャッシュ漏れ監査）

## 目的
Claude Code のセッション JSONL を読み、**1セッション内でプロンプトキャッシュが漏れた箇所**を機械的に洗い出すCLIを作る。
X-0024 の主張（モデル固定・休憩時コンパクト・/usageでヒット率確認）を、感覚ではなく実測で検証できるようにするのが狙い。

## 作るファイル（この2つだけ。他は編集しない）
1. `tools/cache-warm-audit.mjs` — CLI 本体。Node ESM。依存パッケージなし（node:fs / node:path / node:os / node:url のみ）。
2. `tools/cache-warm-audit.test.mjs` — `node:test` + `node:assert/strict`。合成 JSONL を `os.tmpdir()` 配下の一時ディレクトリに書いて検証する。

## 入力（Claude Code のセッション JSONL）
`~/.claude/projects/<project>/<sessionId>.jsonl` を行単位 JSON で読む。1行のうち使うのは以下だけ。他のキーは無視する。

- assistant 行: `{"type":"assistant","timestamp":"2026-11-11T05:44:07.560Z","sessionId":"...","message":{"model":"claude-opus-5","usage":{"input_tokens":2,"cache_creation_input_tokens":96589,"cache_read_input_tokens":0,"output_tokens":123}}}`
- user 行: `{"type":"user","timestamp":"...","message":{"role":"user","content":...}}`（トークン集計には使わない。ターン数とコンパクト境界の検出に使う）
- コンパクト境界: 行に `"isCompactSummary":true` がある、または `subtype`/`type` に `compact` を含む行。実データに合わせて両対応にし、判定関数を分離する。
- 壊れた行・JSONパース失敗行は黙ってスキップし、`badLines` に件数だけ数える（例外で落とさない）。

## 出力する指標（セッションごと）
- `sessionId`（ファイル名から。行の sessionId があればそちら優先）
- `startedAt` / `endedAt`（timestamp の最小・最大。無ければ null）
- `turns`（assistant 行数）
- `models`（出現した model の集合）と `modelSwitches`（前の assistant 行と model が変わった回数）
- `inputTokens` = Σ input_tokens
- `cacheReadTokens` = Σ cache_read_input_tokens
- `cacheWriteTokens` = Σ cache_creation_input_tokens
- `outputTokens` = Σ output_tokens
- `hitRate` = cacheRead / (cacheRead + cacheWrite + input)（分母0なら null）
- `estCostUsd`（下記単価）と `estCostNoCacheUsd`（全トークンを非キャッシュ入力として数えた場合）、`savedUsd` = 差
- `flags`（配列。下記）

## フラグ（漏れ検出）
- `MODEL_SWITCH`: modelSwitches >= 1。何回目かも `events` に残す（`{"at": <assistant行のindex>, "from":"claude-opus-5","to":"claude-sonnet-5-5"}`）。
- `COLD_START_LOOP`: cacheWrite >= 50,000 かつ hitRate < 0.2 かつ turns >= 3（毎回キャッシュを作り直している＝ウォームキャッシュが効いていない）。
- `LOW_HIT`: turns >= 5 かつ hitRate < 0.5。
- `COMPACT`: コンパクト境界が1回以上。回数を `compactions` に出す。
- `COMPACT_RECACHE`: コンパクト後に cacheWrite が増え、直後3ターンの hitRate がその前3ターンより下がった場合（キャッシュ再構築の実測）。

## 単価（定数。env で上書き可）
`CLAUDE_INPUT_USD_PER_M`（既定 3）、`CLAUDE_CACHE_READ_USD_PER_M`（既定 0.3）、`CLAUDE_CACHE_WRITE_USD_PER_M`（既定 3.75）、`CLAUDE_OUTPUT_USD_PER_M`（既定 15）。
コメントに「2026-11 時点の Sonnet 系目安。実単価が違う場合は env で渡す」と書く。

## CLI
```
node tools/cache-warm-audit.mjs [--dir <path>] [--since YYYY-MM-DD] [--top N] [--json] [--min-turns N] [--help]
```
- `--dir` 既定は `path.join(os.homedir(), '.claude', 'projects')`。配下を再帰的に `*.jsonl` 探索。
- `--since` は startedAt（無ければファイルmtime）で絞る。
- `--top` 既定 10。`--json` で機械可読（`{generatedAt, dir, sessions:[...]}`）。
- `--min-turns` 既定 1。
- テキスト出力は1セッション1行の表＋末尾に「合計 hit率 / 合計削減額 / フラグ別件数」。日本語ヘッダ。色は付けない。
- 一致ファイル0件・ディレクトリ無しでも exit 0 で「対象なし」を出す（落とさない）。

## テスト（必ず通す）
1. 合成 JSONL 3セッション:
   - A: モデル固定・cacheRead 大・hitRate 高 → フラグなし、savedUsd > 0
   - B: 途中で model が変わる → `MODEL_SWITCH` と events の from/to が正しい
   - C: 毎ターン cacheWrite 大・cacheRead 0 → `COLD_START_LOOP` と `LOW_HIT`
2. 壊れた行（`{oops`）を混ぜても throw せず `badLines` が増える。
3. `--json` の出力が JSON.parse でき、`sessions.length` が期待どおり。
4. `--since` で古いセッションが除外される。
5. hitRate の分母0（usage 無し assistant 行のみ）で null になり落ちない。

実行: `node --test tools/cache-warm-audit.test.mjs` が緑になること。`node tools/cache-warm-audit.mjs --help` が exit 0。

## 禁止事項
- この指示書ファイルとテストの期待値を書き換えない。テストを緩めない。
- 他ファイルの編集・新規ファイル追加（上記2つ以外）・再委譲・ネットワークアクセス・外部送信をしない。
- 実在の `~/.claude/projects` を読むのは手動確認のみ。テストでは必ず一時ディレクトリを使う。
