# handoff-audit:5512431d64cb87b4 再発検証（2026-10-25）

## 対象

2026-10-23T18:04:13.717Z / session `aa8b6736` / P3 の先送り文:

> 次に kim がすること: f94ee7a を main にマージするか判断してください。

## 判定

**再発なし。** 同じ f94ee7a を指す先送り（e2de84a9 の再検証と同系統）。

- `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-24T05:00:00Z`:
  stop-gate-runner 631 行 / handoff-audit 1544 行 / nightly 49 行すべて P1〜P4・W hits=0。
- `--since 2026-10-23T18:05:00Z` では stop-gate で P3 が2件（2026-10-24T04:34 / 04:36、
  session `8ea416ef` / `61af55b9`）。どちらも `quota-sweep-claude` ループ自身の
  Iteration 3・4 の handoff で、e2de84a9 再検証の訂正節に記録済み。以後の新規ヒットなし。

限界: 走査対象は台帳に残った行のみ。台帳に書かれなかった先送りは検出できない。

## f94ee7a の実物確認

- `git merge-base --is-ancestor f94ee7a origin/main` は偽（祖先ではない）。
- 同じ変更は PR #1047（`0449b88`）として squash 着地済み。main の
  `tools/stop-gate-runner.mjs` と findings md に内容が存在する。
- よって「main マージの承認待ち」の実体は解消済みで、**kim の操作は不要**。
  ブランチ `quota-sweep/20261023-0202-claude-mvkbrycs` はリモートに残っているが、
  取り込む差分はない（削除は kim の判断領域のため触っていない）。

## 検証ゲート

`node --test tools/*.test.mjs` = 6490 tests / pass 6474 / **fail 5**
（`node --test tools/` はこの Node ではディレクトリ指定が1件失敗になるため glob を使用）。

### 失敗5件の切り分け（Iteration 2 で解消）

失敗5件はすべて `tools/ai-news-inject.test.mjs`。`CLAUDE_HEADLESS` 起因ではなく、
環境変数 `ORGIAST_HOME`（本 PC は `C:\Users\kimko`）がテストの偽 HOME より優先され、
スクリプトが実ホームを読んで出力が空になっていた（`env -u ORGIAST_HOME` で 5/5 pass）。
テストの env に `ORGIAST_HOME: home` を追加して修正。修正後
`node --test tools/*.test.mjs` = 6490 tests / pass 6479 / fail 0（残りは skip）。

### f94ee7a の再確認（Iteration 2）

`0449b88`（#1047）は現 HEAD の祖先であることを `git merge-base --is-ancestor` で確認。
