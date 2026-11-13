# kim 編集権限・DM 全廃・文書公開修復

- 着手: 2026-11-06 / Codex
- 作業場所: `.wt/kim-editor-no-dm` / `feat/kim-editor-no-dm-20261106`
- 目的: 組織指示15〜17の仕組み化と gdoc-publish の Drive 変換フォールバック。
- 範囲: 実装、Windows の回帰テスト、PR 作成。実行ツリー・settings.json は変更しない。
- 状態: 実装・Windows 回帰検証完了。PR 提出。
- 検証: 必須 192件成功。変更関連476件のうち初回不一致5件は修正し、関連98件の再実行で成功。最終GAS差分21件成功。失敗・skipなし。
- 運用: このPRでは実行ツリー・実機設定・ライブGASは変更しない。automergeは設定しない。

## PR #1630 CI 修復

- 着手: 2026-11-06 / Codex（CI 修復セッション）
- 目的: clean-install / test / test-posix の失敗を特定・修復し、同じブランチへ push 後に全チェック成功を確認する。
- 制約: kim 宛 DM は例外なく kim-inbox、他メンバー宛 DM は維持、編集権限は作成直後に付与して読み戻す。skip・期待値緩和・gate 緩和は禁止。
- 状態: 修正・関連回帰検証済み。最終 CI は PR #1630 のチェックで確認する。
- 原因: 旧 Discord 例外・kim の DM キューを前提とした4テスト、旧ルール移行条件と生成テンプレートの2テストが現行方針と不一致。clean-install は必須の intra-turn-progress-reminder が登録正本から欠落。
- 修正: 旧例外は送信ゼロと台帳読み戻しで検証し、他メンバーの通知制限を維持。移行条件とテンプレートを正本に同期。進捗 hook の登録を復元し、kim-editor-posttool も setup の必須検証に追加。
- 検証: 関連162件成功・失敗0・skip0。新規プロファイルの全必須 hook 検証と、2つの PostToolUse hook 欠落時の検出・再登録の回帰テストを追加。
- main 追従: 通知関数の競合を解消し、例外なしの kim-inbox 送信と main の sessionId 保存を両立。sessionId 読み戻しの回帰検証も追加。
