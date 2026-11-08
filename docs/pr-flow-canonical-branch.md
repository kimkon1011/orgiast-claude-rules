# PR提出経路の変更: fork経由から正本リポジトリ直接ブランチへの移行

## 概要
本ドキュメントは、PR（プルリクエスト）提出経路におけるfork経由から正本リポジトリへの直接ブランチpush方式への移行について記述したものです。

## 従来の fork→PR 経路とそれが必要だった理由
従来、開発アカウント（`nishiOrgiast`）は正本リポジトリ（`kimkon1011/orgiast-claude-rules`）への書き込み（push）権限を持たず、pull（読み取り）権限のみを有していました。
そのため、変更を提案する際は以下の手順を踏む必要がありました。
1. 開発者個人のforkリポジトリにプッシュ
2. forkリポジトリから正本リポジトリへPRを作成

しかし、この方法ではGitHub Actionsのトークンや第三者コードに不必要な書き込み権限を渡さないための安全設計上、自動マージ（auto-merge）が動作しないという制約がありました。また、`gh pr merge` も権限不足エラーにより失敗し、最終的なマージを `kim` による手動に依存せざるを得ず、開発の滞留原因となっていました。

## 権限変更に伴う新しい経路
2026-09-25の実測により、開発アカウント（`nishiOrgiast`）が正本リポジトリのcollaboratorとして登録され、**write（書き込み）権限**（`push: true`）を有していることが確認されました。
これにより、正本リポジトリに直接ブランチをプッシュしてPRを作成する以下の**「新しい推奨経路」**が利用可能となりました。この経路では、後述の条件を満たすことで完全自動マージが動作します。

### 新しいPR送信・自動マージ有効化の手順（コマンド列）
以下のコマンドをそのままコピーして実行可能です。

```bash
# 1. 新しいフィーチャーブランチを作成してチェックアウト
git checkout -b feat/your-feature-name

# 2. 変更をコミット（必要なファイルのみをパス指定で add すること）
git add path/to/changed-file.js
git commit -m "feat: 変更内容の分かりやすい説明"

# 3. 正本リポジトリ（origin）に直接ブランチをプッシュ
git push origin HEAD

# 4. PRの作成
gh pr create --repo kimkon1011/orgiast-claude-rules --base main --head feat/your-feature-name --title "feat: 変更内容" --body "変更詳細"

# 5. automerge ラベルの付与（これによりGitHub Actionsによる自動マージが有効化される）
gh pr edit <PR番号> --repo kimkon1011/orgiast-claude-rules --add-label automerge

# 6. 自動マージ要求が有効になっているかの確認（null なら効いていない）
gh pr view <PR番号> --repo kimkon1011/orgiast-claude-rules --json autoMergeRequest
```

## auto-mergeが有効化・動作する5つの条件
PRに `automerge` ラベルを付与した後に自動マージ（squash auto-merge）が動作するためには、以下の**5つの条件をすべて満たす**必要があります。

1. **ブランチが正本リポジトリに存在すること**
   - `head.repo.full_name` が正本リポジトリと同じ（＝forkからのPRは対象外）。
   - コメントに記載されている意図: 「fork の token や第三者コードに書き込み権限を渡さないため、base と同じリポだけを対象にする」
2. **PRがDraft（下書き）状態ではないこと**
3. **PRの作成者（author）がcollaboratorであること**
4. **PRに `automerge` ラベルが付与されていること**（※このラベルはリポジトリに事前に作成されています）
5. **変更ファイルが特定のセキュリティ境界や構成ファイルに該当しないこと**
   - 変更ファイルに以下のパス・パターンが含まれている場合、自動マージはバイパスされ、`🔒 kim の手動マージが必要(理由: <path>)` とコメントされて人間のマージが必須となります。
     - `.github/workflows/*` （ワークフロー定義）
     - `*keyserve*` （資格情報管理など）
     - `*secrets*` （シークレット関連）
     - `*.env*` （環境変数関連）

## kim の手動マージが必要となる変更とその理由
ワークフロー定義（`.github/workflows/*`）や資格情報（`*keyserve*` / `*secrets*` / `*.env*`）に関わる変更は、システム全体のセキュリティや全PC（fleet）への配布の安全性を担保するため、安全弁（ガードレール）として、GitHub Actionsによる自動マージ対象から除外されます。
これらの安全に直結する変更は、人間（`kim`）が内容を精査したうえで手動マージを行うことになります。

## 手動でマージするときは REST を使う

`gh pr merge` は GraphQL の `mergePullRequest` を呼ぶため、write 権限があっても拒否されることがある（2026-09-24 実測）。その場合でも REST なら通る。

```bash
gh api -X PUT repos/kimkon1011/orgiast-claude-rules/pulls/<PR番号>/merge -f merge_method=squash
```

GraphQL のエラーだけを見て「マージできない」と報告しないこと。まず `gh api repos/kimkon1011/orgiast-claude-rules --jq .permissions` で現在の権限を実測する。

## ブランチ保護（Branch Protection）の状態について
本アカウント（`nishiOrgiast`）の権限（`admin: false`）からは、`main` ブランチの保護設定の取得API（`GET /branches/main/protection`）が `404` を返すため、保護設定の有無や詳細については**未確認**です。
