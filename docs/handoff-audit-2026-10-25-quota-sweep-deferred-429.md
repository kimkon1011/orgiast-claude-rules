# handoff-audit 検証記録: quota-sweep claude の deferred 3 回連続（HTTP 429、2026-10-25）

対象 TODO: `[handoff-audit:7c5815092275ce5c] quota-sweep claude: deferred が 3 回連続`
再発防止の経路: `quota-sweep.jsonl の deferred 行（利用窓を読めない一時障害のため次回へ延期: HTTP 429）を確認し、利用窓が読めない原因を特定して回帰テスト付きで修正しPRを作成する`

## 1. 結論

1. **原因: `oauth/usage` の 429 が十数分続く。** 2026-10-24T14:13Z〜14:34Z と 10-25T03:16Z〜03:34Z の 2 回、
   リトライ 3 回（2s/15s/30s、合計約 47 秒）が全滅し、`window-unreadable` の deferred が 3 件
   （10-24T14:15 / 10-25T03:17 / 10-25T03:34）続いた。deferred は failed ではないので
   delegation-health には出ず、`queueRepeatedDeferral` が 3 連続で本 TODO を起票した（設計どおり）。
2. **修正は既に main にある。** `tools/lib/quota-windows.mjs` の `readClaudeWindows` が、成功した読み取りを
   `~/.claude/quota-claude-window-cache.json` に残し、一時障害（network / 408 / 429 / 5xx）のときだけ
   10 分以内かつ `resets_at` が未来のものを `stale: true` で返す。#1121（救済コミット）経由で入った。
3. **回帰テストも既にある。** `tools/lib/quota-windows.test.mjs:46-53` が、キャッシュ無しは従来どおり失敗 /
   5 分後は stale で返る / 10 分超は使わない / `resets_at` が過去なら使わない / 401 は使わない、を固定する。
   deferred 化の側は `tools/quota-sweep.test.mjs:276`（429 継続 → 3 回再読 → deferred）が固定する。
   同じ症状に別テストを足すのは重複のため、コード変更は無い。
4. **修正後の実測で効いている。** #1121 のコミット（2026-10-25T08:43Z）以降、claude の窓読み取り失敗は
   ログに 0 件。キャッシュファイルは `2026-10-25T13:19:30Z`（修正後）に書かれており、成功読み取りで更新されている。
   13:03Z の deferred は `interactive-active`（対話セッション使用中）で、窓読み取りとは無関係かつ
   `queueRepeatedDeferral` のカウント対象外。
5. `node --test tools/lib/quota-windows.test.mjs tools/quota-sweep.test.mjs` は 64 件中 pass 63 / skip 1 / fail 0。

## 2. 残る限界（監視事項）

- キャッシュの有効期間（10 分）より 429 が長く続く場合（実測は約 18〜20 分）、後半は従来どおり deferred になる。
  deferred は非終端で次回 tick（15 分後）に再試行されるため害は小さい。有効期間を延ばすと古い使用率で
  枠判断をするリスクが増えるので、今回は変更しない。再発して実害（枠を使い切らずに失効）が出たら
  `Retry-After` ヘッダーの尊重を検討する。
- 修正後の観測期間は短い（実走行は 13:03Z の 1 回のみ）。次の実走行で `window-unreadable` が 3 連続したら
  `queueRepeatedDeferral` が再起票する。

## 3. 検証コマンド

```bash
node --test tools/lib/quota-windows.test.mjs tools/quota-sweep.test.mjs
node -e "const fs=require('fs');const rows=fs.readFileSync(process.env.HOME+'/.claude/quota-sweep.jsonl','utf8').trim().split(/\n/).map(JSON.parse);console.log(rows.filter(r=>r.ts>'2026-10-25T08:43:00Z'&&/window-unreadable|HTTP 429/.test(r.reason||'')).length)"
```
