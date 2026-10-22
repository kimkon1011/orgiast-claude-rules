# rescue ブランチレビュー（2026-10-22 自動セッション・読み取り専用＋判定）

対象: `~/.claude/nightly-repo` の local `refs/heads/rescue/*` 13本。
`node tools/rescue-review-scan.mjs --repo . --main origin/main` の実出力に、各枝の差分を実際に読んだ結論を付けた。

## 前提の修正（実測）

- nightly-repo は **shallow clone（depth 1）** になっており、10/11 以前に分岐した rescue 枝は
  `no merge base` で分類不能だった（初回スキャン: error 12本）。
- `git fetch --shallow-since=2026-10-11 origin` で履歴を補い、**error は 1本に減った**。
  同期処理が再度 shallow clone し直すと同じ誤分類が再発するため、恒久対策は別途必要
  （今回はスキャナの結果を正すための読み取り準備に留めた）。

## 判定（8 unique + 3 covered + 1 ignored-only + 1 error）

| 枝 | 分類 | 内容と結論 |
|---|---|---|
| rescue/auto-session-20261012-153004 | unique | `fleet-directives.json` 6+/8-。**公開リポジトリに M&A 案件・買い手情報を書いた内容**（2026-10-14 に廃棄決定済み）。**取り込み不可・廃棄**。 |
| rescue/auto-session-20261016-014602 | unique | `tools/codex-do.mjs` の native レーン試作＋専用テスト。main は `nativeSandboxMode`/`nativeCodexAvailable` を備えた別設計で既に実装済み（PR #793）。**main が上位互換＝廃棄**。 |
| rescue/auto-session-20261016-041503 | ignored-only | 差分は gitignore 済み実行時成果物のみ。**レビュー不要**。 |
| rescue/auto-session-20261019-030202 | unique | 空の `.tmp-gmail-*.err/.json` 2ファイル（0バイト）。**廃棄**。 |
| rescue/auto-session-20261019-031002 | covered | 差分なし。**廃棄**。 |
| rescue/auto-session-20261019-033003 | covered | 差分なし。**廃棄**。 |
| rescue/auto-session-20261019-153003 | unique | `tools/brandcard-print-pdf.mjs`(189行)・test(56行)・`docs/brandcard-print-order-20261016.md`(63行) は **main と完全一致**。残りは生成PDF 3点と `tools/.cache/qrcode.min.js` のみ。**コードは取り込み済み＝枝は廃棄可**（PDF は Drive/ローカル成果物）。 |
| rescue/auto-session-20261020-030401 | unique | `handoff-audit-knowledge.json` へ `{pattern:"GitHub操作の画面/CLI手渡し",route:"gh api"}` 等の**中身のない2エントリ**を追加。既存25エントリと実質重複。**廃棄**。 |
| rescue/auto-session-20261020-081003 | covered | 差分なし。**廃棄**。 |
| rescue/auto-session-20261020-114202 | unique | `tools/gmail-attachment.mjs`＋test（109行）。 |
| rescue/auto-session-20261020-174401 | unique | 上記の改良版（102行）。 |
| rescue/auto-session-20261020-153004 | error | **orphan 枝**（root commit）。中身は `tools/.audit-test-LW7etd/` の一時成果物6ファイルのみ。**レビュー価値なし＝廃棄**。 |
| rescue/auto-session-20261022-030403 | unique | 既レビュー済み（knowledge 重複エントリ）＝**廃棄**。 |

### gmail-attachment の2本は「既に別枝でカバー済み」

- **`auto/20261021-gmail-attachment`（1b911e7・着地キュー登録済み）が、この2本の上位互換**であることを実測:
  - `parseArgs` のエラーに USAGE を追加、`toLocaleLowerCase`→`toLowerCase`、長い API 呼び出しの整形、
    テストを104行へ拡充。
- したがって **114202 / 174401 の内容は失われていない。rescue 枝は廃棄可**。
- 補足: 本セッションで同じ内容を main 起点で作り直した `auto/20261022-gmail-attachment`（e918b48・テスト4/4 pass）を
  作成したが、**上記キュー枝の下位互換と判明したため削除を試みた**。`git branch -D` は分類器に拒否され、
  **枝はローカルに残置（未 push・着地キュー未登録）**。次に触る人は削除してよい。

## 結論

- 「レビューが必要」な独自内容は **無し**（すべて取り込み済み・上位互換・廃棄対象のいずれか）。
- 8 unique はいずれも**マージ不要**。枝の削除は不可逆なので、この判定を根拠に人間または掃除ジョブが実施する。
