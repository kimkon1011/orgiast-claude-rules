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

## 7. 渡す成果物は必ず Drive へ（案件データは案件の制作フォルダ）

- ユーザー・他人に渡す成果物（PDF/画像/文書/表/ZIP 等）はすべて Google Drive にアップし、リンクを貼って渡す。ローカルパス（Desktop 等）・SendUserFile・チャット添付だけで渡したら未完了（スマホ併用で開けず、他人にも渡せない）。
- 置き場: 案件に属するデータはその案件の制作フォルダ（Drive で `制作フォルダ`・案件コード `C0040` 等・顧客名で検索して特定）。案件外は「作業ファイル」直下。
- リンクは URL 規約どおり（自分用は `?authuser=<自分のorgiast.jpメール>`、他人宛は共有設定とアカウント切替の案内を併記）。アップロードは Drive MCP か `node tools/drive-upload.mjs --file <path> --folder <folderId> [--name <name>] [--as <email>]`（JSON `{id,name,url}` を返す）。
- サブエージェント／Codex に生成を委ねるときも、指示に保存先＝Drive の該当フォルダを書く（Desktop を指定しない）。
- 機械化: stop hook の doc-link-drive-guard（バッククォート・裸の絶対パス検出。内部用は `[LOCAL-PATH-OK]`）と user-burden-gate（Desktop のファイルパスを完成品として受理しない。.cmd ランチャーは別用途で可）。
- 事故履歴: 2026-09-24 温根湯 FAX 送付状をローカル保存のまま報告。2026-10-07 出展者証 PDF を Desktop に保存しローカルパスとスマホ送信だけで完了報告。いずれも guard の裸パス検出が stop-gate-runner に配線されておらず、user-burden-gate が Desktop パスを完成品として受理していたため素通りした。
