安いAIレーンのprobeだけが成功している間に実呼び出しが失敗し続け、Claude本体で実装を続ける問題を防ぎます。24時間の実績を優先して故障を判定し、全PCのPreToolUseで修復試行前の通常作業を止めます。

- 実呼び出し5件以上・非quota失敗率50%以上を real_fail_rate、既知のresetがある上限待ちを quota_wait として分離。
- 同一故障の修復記録を6時間有効とし、修復不可3回連続でnotify-kimに1回通知。SessionStartにも修復優先と代替レーンを表示。
- 検証済み監査ルール、日次applyタスクのconverge登録、テンプレートとONBOARDINGを配布経路に追加。

検証: 追加48テスト全通過。関連305テストで失敗0、既存Windows専用1件はLinuxで対象外。selftest-guards 68 PASS。検出器の人工正例・負例28件でprecision/recall=1。実データではDeepSeekの直近24hが27/27失敗でreal_fail_rate、7日監査は新ルール5/5セッション違反でblock。詳細は reports/lane-repair-first-20261029.md。

実機への反映は未完です。このセッションから本物の ~/.claude は読み取り専用で、lane-health/enforcement保存とsettingsへの登録は実行できませんでした。テスト用HOMEではgateのexit 2→修復記録→exit 0、converge登録とenforcement生成を実行確認しています。先行PR #1273を含む最新mainから作成しています。
