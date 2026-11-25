# 追記: handoff-audit 7c5815092275ce5c 再検証（2026-10-26）

対象: `docs/handoff-audit-2026-10-25-quota-sweep-deferred-429.md` の §1-4「修正後の窓読み取り失敗は 0 件」の訂正。

## 実測

- `node --test tools/lib/quota-windows.test.mjs tools/quota-sweep.test.mjs`: 56 件中 pass 55 / skip 1 / fail 0（quota-windows 単体は 8/8 pass）。
- `~/.claude/quota-sweep.jsonl` で #1121 反映（2026-10-25T08:43Z）以降の `HTTP 429` / `window-unreadable` を再集計したところ **1 件**。
  2026-10-25T18:28:04Z（claude / 5h 窓、`outcome: deferred`、`reason: 利用窓を読めない一時障害のため次回へ延期: HTTP 429`、`failureKey: null`）。
  前記録の「0 件」は不正確。
- 直後の実走行は 18:33Z final、22:21Z / 03:21Z は exhausted（枠・試行上限）で、窓読み取りは成功している。deferred は連続せず、
  `queueRepeatedDeferral` の 3 連続条件には達していない。

## 判断

- キャッシュは効くが、有効期間（10 分）を超える 429 継続、またはキャッシュ未作成の状態では従来どおり deferred になる。設計どおりの限界。
- コード変更なし。前記録 §2 の「次の一手」（再発して実害が出たら `Retry-After` を尊重）を維持する。現時点の実害は無い（次 tick で成功、枠失効なし）。
- 監視: deferred が 3 連続で再起票されたら `Retry-After` 対応を回帰テスト付きで実装する。
