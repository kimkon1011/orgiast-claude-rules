# handoff-audit 検証記録: quota-sweep claude の window-info 連続失敗（2026-10-25 再検証）

対象 TODO: `[handoff-audit:6d4ea6ec4a15cedf] quota-sweep claude: window-info の連続失敗`
再発防止の経路（route）: `tools/quota-sweep.mjs の window-info を quota-sweep.jsonl とログで調査し、回帰テスト付きで修正してPRを作成する`

id は `sha256(JSON.stringify([NFKC(pattern), NFKC(route)])).slice(0, 16)` で再計算し一致を確認した
（`6d4ea6ec4a15cedf` / 全文 `6d4ea6ec4a15cedf033e41ae0f473534814990a4ce32364d57cd0ad12c885eb1`）。

## 1. 結論

1. **再発 0。** 原文検出の最後の行 `2026-10-23T20:22:39.321Z` より後の台帳 4 行に、claude の
   `failureKey=window-info` は **0 行**（§2）。ログにも claude の `window-info:` 行は
   `2026-10-23T20:06:59Z` を最後に出ていない。
2. **修正は既に main に載っており、実運用で効いている。** `2026-10-24T14:13:31Z〜14:15:04Z` に
   HTTP 429 が続いたとき、従来なら `failed(window-info)` になっていたところ、リトライ 3 回
   （2s/15s/30s）後に **`window-unreadable` の deferred** で次回へ延期し、`failed` にしていない
   （ログ 405–410 行）。その後の ledger 行も `failureKey=child-deadline` で、window-info ではない。
3. **回帰テストは既に同梱されている。** `tools/quota-sweep.test.mjs:276` が「429 が続く → 3 回読み直す →
   `deferred`・子プロセス起動 0・reason に HTTP 429」を、`:296` が一時障害の判定範囲を、`:289` が
   非一時障害（401 等）は従来どおり `failed(window-info)` を固定している。よって**今回新規のコード修正は
   不要**（同じ症状に別の回帰テストを足すのは重複）。
4. **別 provider の 1 件はこの handoff の再発ではない。** `2026-10-23T23:24:32Z` の codex 行は
   `window-info` だが理由が `No rate_limits in latest Codex log`（一時障害ではない・別レーン）。
   `quota-sweep-state.json` の `failureStreaks.codex.count` は **1** で、連続失敗の閾値 2 に達していない。
5. knowledge に本 pattern の entry を追加した（§4）。同じ調査を次の夜間監査が繰り返さないよう、
   実測した台帳・ログ行と判定コマンドを残す。

## 2. 実物の走査（読み取りのみ / 2026-10-24T17:17Z 時点）

窓 = 原文検出を出した最後の行 `2026-10-23T20:22:39.321Z` より後〜現在。原文の 2 行は
`2026-10-23T19:52:17.360Z` と `20:22:39.321Z`（どちらも `reason=利用窓情報が不足または不正: [] (HTTP 429)`、
`ticks=1/2`、`prUrl=#1059` の partial 実行中に発生）。

| 台帳 | 全行 | 窓内行 | claude `window-info` | codex `window-info` |
|---|---:|---:|---:|---:|
| `~/.claude/quota-sweep.jsonl` | 24 | 4 | **0** | 1（理由は Codex ログ由来・別レーン） |
| `~/.claude/quota-sweep.log`（`window-info:` 行） | 428 | 1 | **0**（最後は 10-23T20:06:59Z） | 1（10-23T23:24:29Z） |

窓内の claude 4 行の内訳:

| ts (UTC) | outcome | failureKey | 備考 |
|---|---|---|---|
| 2026-10-24T09:00:41Z | failed | `interactive-active` | 対話セッション検出。別 handoff（修正済み #1073/#1079） |
| 2026-10-24T09:48:58Z | failed | `interactive-active` | 同上 |
| 2026-10-24T14:59:07Z | failed | `child-deadline` | 子プロセスの制限時間。途中で 429 → deferred 済み（§3） |

ログの 429 連続と deferred の実測（`~/.claude/quota-sweep.log`）:

```
405: 2026-10-24T14:13:31.556Z claude: window read failed (HTTP 429); retry 1/3
406: 2026-10-24T14:13:43.057Z claude: window read failed (HTTP 429); retry 2/3
407: 2026-10-24T14:14:43.007Z claude: window read failed (HTTP 429); retry 1/3
408: 2026-10-24T14:14:46.649Z claude: window read failed (HTTP 429); retry 2/3
409: 2026-10-24T14:15:04.937Z claude: window read failed (HTTP 429); retry 3/3
410: 2026-10-24T14:15:36.654Z claude: window-unreadable: 利用窓を読めない一時障害のため次回へ延期: HTTP 429
```

`~/.claude/quota-sweep-state.json`: `failureStreaks.claude = {key: child-deadline, count: 1}`、
`failureStreaks.codex = {key: window-info, count: 1}`、`deferredStreaks.claude = {count: 0}`。
**window-info の連続カウンタはどちらのレーンも 0/1 で、再起票の閾値に達していない。**

観測限界: 最後にレーンが実際に走ったのは `2026-10-24T14:59Z`。その後はログ最終行 `17:08:08Z` まで
`skip: no eligible reset window` が 9 回続いており、**窓読み取りの成否を試す実行自体が無い**。
したがって「再発 0」は「走った 4 行＋ログで 0」の意味であり、次の実走行でも同じ判定を続ける。

## 3. コード側の再発防止（本番 HEAD に配備済み）

`~/.claude/nightly-repo` HEAD `3555e85` は、以下の修正を含む（`git merge-base --is-ancestor d4ce5f2 HEAD` = 真）。

| 防御 | 場所 | 内容 |
|---|---|---|
| 一時障害の限定判定 | `tools/quota-sweep.mjs:129-131` | `network:` / `HTTP 408|429|5xx` だけを再試行対象。401/403・形式不一致は再試行しない |
| 間隔を空けた再読 | `tools/quota-sweep.mjs:300-308` | 2s → 15s → 30s の 3 回。429 が続く間に確認で failed になるのを防ぐ |
| deferred 化 | `tools/quota-sweep.mjs:309` | 再試行後も読めなければ `window-unreadable` の deferred（非終端）にし、delegation-health のレーン全滅誤判定を避ける |
| 成功のみ短期キャッシュ | `tools/quota-sweep.mjs:468-482` | 1 スイープで同じ API を数十秒に 3 回叩かない。失敗はキャッシュせず再試行を妨げない |
| 理由の executor-usage 記録 | `tools/quota-sweep.mjs:443-449` | `window-info` の理由が `no_output` に潰れない |
| 回帰テスト | `tools/quota-sweep.test.mjs:270,276,289,296` | 再読で回復する / 429 継続で deferred / 非一時障害は failed / 判定範囲 |

修正の系譜: #1051（理由消失）→ #1052（executor-usage へ理由）→ #1056（一時障害で全滅誤判定しない）→
#1060（429 継続を deferred に）。

### 検証コマンド（再実行用）

```bash
node -e "const fs=require('fs');const rows=fs.readFileSync(process.env.HOME+'/.claude/quota-sweep.jsonl','utf8').trim().split(/\n/).map(JSON.parse);const cut='2026-10-23T20:22:39.321Z';console.log(rows.filter(r=>r.ts>cut&&r.provider==='claude'&&r.failureKey==='window-info').length)"
node --test tools/quota-sweep.test.mjs
```

## 4. 残ること

- 監視のみ。次の実走行で claude `failureKey=window-info` が出たら、`queueRepeatedFailure` が 2 連続で
  自動再起票する（既存の仕組み）。deferred が 3 連続した場合は `queueRepeatedDeferral` が別 TODO を起票する。
- 本記録によるコード変更は無い（回帰テストは既存）。knowledge の entry のみ追加した。
