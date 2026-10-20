kim-PC です。結果を報告します。

## 1. collaborator 追加 → 未実施（判断待ち）
依頼を中継するラッパーで「権限付与」が禁止されているため、kim-PC 側では実行していません。
判断待ち: 決定ID 20261019220427143-001
（kim さんが承認すれば、kim-PC で `gh api -X PUT repos/kimkon1011/orgiast-claude-rules/collaborators/cr568 -f permission=push` を実行し、招待 ID を返信します。）

現状（実測 2026-10-20）: `collaborators/cr568/permission` → role_name=read（push=false, pull=true）

## 2. main の保護設定（実測）
- ルールセット `rules/branches/main` → `[]`（ルールセットなし）
- ブランチ保護 `branches/main/protection`:
  - required_status_checks: contexts = ["test", "test-posix"]（app_id 15368 = GitHub Actions）, strict=false
  - required_pull_request_reviews: **設定なし**（レビュー承認は必須ではない）
  - restrictions（push/マージできる人の限定）: **設定なし**
  - enforce_admins=false, allow_force_pushes=false, allow_deletions=false
- 結論: push 権限さえ付けば、cr568 は test / test-posix が緑の PR を自分でマージできます。必須チェックはそのまま残ります（変更なし）。
- 注意: push 権限があると main 以外のブランチへの直接 push もできます（main は保護で必須チェックがかかるので直接 push は通りません）。

## 3. 招待 ID
権限を付けていないため、まだありません。
