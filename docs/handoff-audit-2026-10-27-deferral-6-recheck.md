# handoff-audit 検証記録: 2026-10-26 の恒久修正先送り 6 件の再発検証（2026-10-27）

対象 TODO: `[handoff-audit:0a203fa474d6eec1]` `655193606ae97496` `dc6679a0f3c1f1c3` `8c514f1b7c9dce5d` `e45bd925625886ef` `60f638ac4444b46b`（いずれも `tools/permanent-fix-deferral-scan.mjs` の 2026-10-25T15:00Z〜10-26T15:00Z 窓・10 hits 由来）。

送信なし・権限変更なし・kim への DM なし。

## 結論

| TODO | セッション / 型 | 先送りされた中身 | 実物の状態（2026-10-27 実測） | 判定 |
|---|---|---|---|---|
| 60f638ac | 63a9d454 / P3 | `eee266e`（quota-sweep 第5契約修正）の PR・マージを kim へ | PR #1129 MERGED 2026-10-26T09:20:16Z（head `quota-sweep/20261026-0040-claude-mvoj5kj3`、commit `eee266e` を含む） | 着地済み。ただし下記「再発」の原因 |
| e45bd925 | d4e4168d / P3 | codex-do にクールダウン自己回復パッチを入れるか kim に指示を仰ぐ | origin/main `tools/lib/executor-gate.mjs` の `decideCodexGate` は until 未来なら無条件 deferred、`lane-doctor` も codex_cooldown は「既存のまま触らない」= **未実装** | **未着地 → 本 PR で実装**（fix/codex-cooldown-self-recovery） |
| 8c514f1b | a74a6bf0 / P2 | automerge 恒久策を次セッションへ | PR #1147 MERGED 2026-10-26T11:30:46Z | 着地済み |
| dc6679a0 | 31b38310 / P3 | TETSUKO 成長ループ復元 PR 作成を kim の返事待ちに | genbateamtoho-ctrl/tetsuko-unified PR #21 MERGED 2026-10-26T10:50:05Z | 着地済み |
| 65519360 | db89732e / W | PR #1147 CI 赤の修正を Codex 完了待ちに | PR #1147 MERGED（同上） | 着地済み |
| 0a203fa4 | 355172c1 / W | onboarding-sync の索引上限修正を Codex 完了待ちに | PR #1154（f54ad0e）MERGED 2026-10-26T11:09:22Z | 着地済み |

## 再発走査（未走査窓 2026-10-26T15:00Z〜10-27T06:00Z）

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-26T15:00:00.000Z --until 2026-10-27T06:00:00.000Z --json`:
stop-gate-runner-ledger 830 行中 5 hits（W4 / P3 1）、handoff-audit-ledger・nightly-ledger は 0。

| ts | セッション | 内容 | 判定 |
|---|---|---|---|
| 10-26T17:02〜17:03Z ×3 | eef2728e（quota-sweep claude ループ） | 「全体ゲート完了待ち」「kim への手渡しは eee266e の PR 作成・マージ」 | **同型の再発**（マージ済み物の手渡し） |
| 10-26T17:19Z | 9b335599（同ループ） | 「次に kim がすること: eee266e を PR にして main へ取り込む」 | **同型の再発** |
| 10-27T05:48Z | aa22928b | Codex ランチャー作成中（verdict=pass、進行中） | 先送りではない |

### 再発の真因

ループ契約 `.loop/quota-sweep-claude.md` の C4 が `git merge-base --is-ancestor eee266e origin/main` で取込判定していた。本リポは squash マージのため元 SHA は祖先にならず、PR #1129 着地後も判定が常に偽 → ループが試行ごとに「人の1手 = eee266e の PR 作成・マージ」を kim へ出し続けた（ループ自身が試行4で訂正）。2026-10-25 の `f94ee7a` 関連 7 件（`docs/handoff-audit-2026-10-25-deferral-*-recheck.md`）は逆に「squash 着地のため祖先でない」と推測で着地扱いにしていたが、下表のとおり実際は未取込。祖先判定は偽陰性・推測は偽陽性になり得るので、判定は commit-landed に一本化する。

### 恒久対策（本 PR 群）

1. `tools/commit-landed.mjs`: ancestor → merged PR 検索 → patch-id の順で取込判定する CLI。quota-sweep が生成・読込する契約の `git merge-base --is-ancestor <X> origin/main` を `node tools/commit-landed.mjs <X>` に正規化し、契約生成プロンプトにも明記（fix/commit-landed-squash）。
2. `decideCodexGate`: クールダウン残り 5 時間超なら 6 時間ごとに 1 回だけ生存確認起動を許し、正常終了でクールダウンを解除（fix/codex-cooldown-self-recovery）。

## commit-landed の実測（2026-10-27・origin/main を対象）

| commit | 判定 | 根拠 |
|---|---|---|
| `eee266e` | landed (pr) PR #1129 / mergeCommit `87eb4d8` | PR #1129 の commits に `eee266e` を含む |
| `f94ee7a` | not landed | PR #1085 は本文で言及するだけ（commits=`efdc588`）。枝 `quota-sweep/20261023-0202-claude-mvkbrycs` に PR は 0 本。10-25 の検証記録にある「squash 着地」は根拠がなかった |
| `9b1e6bf` | exit 2（このリポに無い commit） | aujust 側の commit |

初版は `gh pr list --search <sha>` が PR 本文の文字列にも当たり、`f94ee7a`→#1085、`9b1e6bf`→#826 を誤って landed にした。PR の `commits[].oid` と照合する形に直した。
