# Google Drive 運用ルール 詳細

ONBOARDING.compressed.md §2.9 の詳細。

## 2.9 Google Drive 運用ルール — 新規は「作業ファイル」統一、移動は kim の UI ドラッグのみ

1. 新規作成: Claude が Drive MCP `create_file` で作るファイル/フォルダは、特に指定がなければ標準フォルダ 「作業ファイル」（Folder ID `1uA0J3kPfL7O5t0Ro1jSfi2xDEJE-Y0si`、kim マイドライブ）直下に作る。例外 = 機能上の置き場が決まっているもの（GAS コマンドキュー `claude-*-cmds`、freee 仕訳 CSV、`社内マニュアル_NotebookLM連携` 等の既存自動化フォルダ）。
2. Claude は copy_file を「移動」の代用にしない（禁止）: copy は新しいファイル ID の複製を作る。元を削除するツールも無いため重複が残り、ID 参照している自動化と実体がズレる。移動が必要なときは Claude が対象リスト（タイトル / ID / 現フォルダ / 可否判定）を作って kim に渡すところまで。
3. 実際の移動は kim が Drive UI のドラッグで行う: UI 移動は ID 保持（親フォルダだけ変わる）。ただし親フォルダから継承していた共有権限は移動で外れる（ファイルに直接付与した権限は保持）。移動前に Claude が `get_file_permissions` で SA・メンバー共有が「直接付与」かを確認し、継承のみなら先に直接付与を追加してもらう。
4. 絶対に動かさないもの: weekly-bot 参照の 顧問ミーティング / freee仕訳CSV フォルダと SHEET_* 各シート、GAS コマンドキューフォルダ群、bound script 付き Sheet、`社内マニュアル_NotebookLM連携`、自動化が Folder ID で監視・書込する全フォルダ、他人所有ファイル。整理メリット < 事故リスク。
5. マイドライブ ⇔ 共有ドライブを跨ぐ移動は禁止: ID は保持されても owner が組織に移り、権限がドライブのメンバーシップ支配に変わるため、SA の閲覧などが silent に壊れうる。
6. 移動後は Claude が read-back 検証: `get_file_metadata` で「ID 不変 + parentId が新フォルダ」を確認し、そのファイルを参照する自動化（weekly-bot 等）を 1 回手動発火して成功まで見届ける。

由来: 2026-07-06 kim「Claude 作成の Drive データは作業ファイルに統一、過去分も移動可否をチェック」→ Drive MCP に move が無い制約下で「Claude=新規統一+棚卸し / kim=UI ドラッグ」の役割分担で恒久化。
