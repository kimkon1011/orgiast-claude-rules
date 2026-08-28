# gate が不正入力で黙って強制を消す — 沈黙を潰す

## 実測でわかったこと
`~/.claude/rule-enforcement.json` を `block` にした状態で、正しいJSONを流すと gate は期待どおり動く:
```
A 経路3件・却下1件 → {"decision":"block","reason":"既知の自動化経路が3件です。4件以上必要です。"}
B 経路4件・却下2件 → 出力なし（pass）
C 判定ブロックなし   → {"decision":"block","reason":"`[手渡し判定]` ブロックがありません。"}
```
**強制は正しく機能している。**

しかし、**不正なJSONを流すと gate は何も言わずに終了する**（exit 0・stdout空・stderr空）。
`main()`:
```js
let input; try { input = JSON.parse(raw); } catch { return; }
```
検証中、生の改行が混ざった不正JSONを流していて、この経路で20分近く「gateが壊れている」と誤診した。
実運用でも Claude Code が想定外の payload を送れば、**強制が静かに消えて誰も気づかない**。
今日繰り返し出た「沈黙」型の故障そのもの。

## 修正

### 1. 入力を解釈できなかったら必ず stderr に出す
`main()` の各早期 return に理由付きの警告を入れる:
- stdin が空 → `[handoff-quality-gate] 入力が空のため判定をスキップしました`
- JSON パース失敗 → `[handoff-quality-gate] 入力をJSONとして解釈できず判定をスキップしました: <エラー内容> (先頭120字: <raw の先頭>)`
- `assistant_text` も `transcript_path` も無い / transcript から本文が取れない →
  `[handoff-quality-gate] 判定対象の本文が取得できませんでした (assistant_text/transcript_path なし)`

**exit code は 0 のままにする**（Stop hook を壊さないため）。stderr に出すだけ。

### 2. 「入力はあったのに判定しなかった」回数を記録する
`~/.claude/handoff-gate-skips.jsonl` に1行追記する:
`{ts, sessionId, reason, rawHead}`（`rawHead` は先頭120字。秘匿値が入る恐れがあるので120字に制限）
書き込み失敗時は stderr に警告（既存の ledger と同じ扱い）。

### 3. スキップをレポートに出す
`tools/rule-compliance-loop.mjs` のレポート末尾に
`gate判定スキップ: N件（直近: <reason>）` を出す。**0件なら「0件」と明記する**（沈黙させない）。
`handoff-gate-skips.jsonl` が存在しない場合は `gate判定スキップ: 記録なし` と出す。

### 4. `cron-liveness-check.mjs` に閾値を足す
スキップが直近7日で **3件以上**あれば `🚨 gate判定スキップ N件（強制が効いていない可能性）` を出す。

## 回帰テスト（`tools/handoff-quality-gate.test.mjs` に追加。CLI起動で検証すること）
1. 不正JSON（文字列内に生の改行）を stdin に流す → exit 0 / stdout 空 /
   **stderr に「JSONとして解釈できず」が出る** / skips に1行記録される
2. 空の stdin → stderr に「入力が空」が出る（skips には記録しない。hook の空振りは正常なので）
3. `{"session_id":"x"}` のみ（本文なし）→ stderr に「本文が取得できませんでした」が出る
4. 正常な入力（`decision: block` が返るケース）では **stderr に警告が出ない**
5. 既存36テストが全部green

## 厳守
- 判定ロジック（`evaluateHandoff`）と強制の閾値は変えない
- exit code は常に 0（Stop hook を壊さない）
- `~/.claude` 配下の既存ファイル（settings.json / CLAUDE.md / hooks / rule-enforcement.json）は書き換えない
- 他ファイル（`line-digest.mjs` / `auto-session.mjs` / `booth-feedback-intake.mjs` /
  `nightly-batch.ps1` / `feedback-widget/*` / `.github/workflows/*`）は別作業の未コミット変更。触らない
- `sms-kanri-2026/` 配下は別リポジトリ。触らない
- Windows / ESM(.mjs) / UTF-8 BOMなし。テストで `new URL(...).pathname` を使わない（`fileURLToPath`）

## 検証（自分で実行して出力を貼る）
1. `node --test tools/` が全部green（40件以上、fail 0）
2. 不正JSONを実際に流して stderr が出ることを、コマンド出力を貼って示す
3. `node tools/rule-compliance-loop.mjs --days 7 --dry-run` に
   `gate判定スキップ: N件` が出ることを示す
