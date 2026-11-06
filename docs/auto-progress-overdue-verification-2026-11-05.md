# auto-progress 期限超過の検証（2026-11-05）

ファイル編集のみ。実台帳・実通知先・実行ツリーは変更していない。

## 実装

- check の stdout 全文と stderr を保存。非空行の達成・未達マーカーから件数と内容を要約し、不明な行は判定不明として表示する。
- 期限を過ぎた未達・確認エラーは通常の未達通知を抑止し、既存の再開経路を上限・実行時間・作業場所の制約内で呼ぶ。プロンプトに check 出力全文を含める。
- 再開後も check を再実行して確認する。再開できない場合や再確認が未達の場合は `overdue_reported` で閉じ、最終報告を送る。実行者なしは試行回数・再開時刻を復元する。
- 最終報告には label・約束・達成/未達の要約・再開結果・次の担当と操作を含める。配達失敗時は保存済み最終報告だけを再送する。quiet hours・通数上限による deferred は既存の保留経路へ引き渡す。
- 12時間以上先が期限の check 付き約束は、既存の朝 digest に日次要約を追加。owner ごとの配達受領と JST 日付で二重送信を防ぐ。
- 無人行の48時間掃除は check 付き行を黙って expired にせず、期限の最終確認経路へ残す。

## テスト

```sh
node --test tools/auto-progress*.test.mjs tools/notify-owner.test.mjs tools/owner-dm*.test.mjs
```

277 tests / 277 pass / 0 fail / 0 skipped。
既存テストは削除せず、期限後の定期再通知と出力1行切り捨ての期待値を新仕様へ更新。
新規 `tools/auto-progress-overdue.test.mjs` は8件。再開プロンプト全文、実行者なし、再開後の確認、配達再試行、期限前通知、日次要約、確認例外を検証する。

## 1132行目と同型の fixture

session `5fd545ff-fixture`、deadline `2026-10-30T03:00:00Z`、巡回 `2026-11-05T00:00:00Z`。
実行者・通知を mock にした一時台帳で watch 本体を実行する dry-run 相当の検証。
通常 CLI の `--dry-run` は従来どおり check や再開コマンドを実行しない。
以下は上記テスト実行が出力した実測結果（実台帳の現在状態を示すものではない）。

```json
{
  "fixture": "ledger-line-1132",
  "transitions": [
    "open",
    "resumed",
    "overdue_reported"
  ],
  "resume": "check-overdue",
  "report": "【auto-progress-test-PC・test-owner@example.com の Claude Code】プロジェクト: overdue-fixture-4edvF4 ／ セッションの目的: 安いAIレーン修復の強制: 03:50監査・7:20日次更新・全PC配布の回収 ／ 作業ID: 5fd545ff\\n最終報告（期限超過・未完了）: 安いAIレーン修復の強制: 03:50監査・7:20日次更新・全PC配布の回収\\n期限切れ（2026-10-30T03:00:00Z）\\n約束: 全PCの安いAIレーンを修復して配布を確認する\\n達成 2件 / 未達 1件\\n達成: PC-A: gate配布=完了 ／ PC-C: gate配布=完了\\n未達: PC-B: gate配布=なし\\n再開結果: 実行者なし\\n次の一手: Claude の次の手: 担当AIがPC-Bの配布を修復して再確認する"
}
```

同じ fixture を25時間後に再巡回して、check/再開/最終報告の再実行がないことを assert した。
別 fixture で最初の配達を失敗させ、次回は最終報告のみを配達し、さらに次回の重複がないことも確認した。

件数は check 出力の行単位の分類。独自形式や判定印のない行の達成数は推測せず、判定不明として残す。
