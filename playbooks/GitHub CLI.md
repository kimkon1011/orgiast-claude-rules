aliases: gh, GitHub, github-cli, gh auth, pr-land, automerge

# GitHub CLI（gh）— このPCの実測

実測のみ。一般知識で補わないこと。

## 大前提: `GH_TOKEN` 環境変数が keyring より強い（2026-10-26 実測）

`gh auth status` は **2行**出る。

```
✓ Logged in to github.com account <認証アカウント> (GH_TOKEN)
  - Active account: true
  - Token scopes: 'gist', 'read:org', 'repo'
✓ Logged in to github.com account <認証アカウント> (keyring)
  - Active account: false
  - Token scopes: 'gist', 'read:org', 'repo'
```

`Active account: true` が付く方＝実際に使われる方。**常に `GH_TOKEN` 側が勝つ**。
`GH_TOKEN` はユーザー環境変数に永続化済み（参照先: memory の
`reference_github_auth_persist_env_var.md`。値そのものはここに書かない）。

## 成功した手順: 認証が切れたときの復旧（user の TTY）

1. **PowerShell** または **Git Bash** を開く
2. `gh auth login --hostname github.com --git-protocol https --web` を実行
3. 画面に `! First copy your one-time code: XXXX-XXXX` が出る → 8桁をコピー
4. `Press Enter to open github.com in your browser...` で **Enter**（ブラウザが自動で開く。
   開かなければ https://github.com/login/device を手で開く）
5. コードを貼り **Continue** → 権限を確認して **Authorize github**
6. ターミナルに `✓ Authentication complete.` が出れば成功
7. **ここで終わらせない**。`GH_TOKEN` を取り直して永続化する（これを忘れると古い
   `GH_TOKEN` が使われ続け、せっかくのログインが無視される）:
   ```powershell
   $t = (gh auth token).Trim(); [Environment]::SetEnvironmentVariable('GH_TOKEN', $t, 'User')
   ```

## 失敗した手順とその原因

### ✗ Claude 側からのヘッドレス起動は承認前に失効する（2026-10-26・2回連続）

`gh auth refresh` / `gh auth login --web` を stdin=`/dev/null` のバックグラウンドで起動すると、
ワンタイムコードは出るが、user が承認する前に **`context deadline exceeded`** で死ぬ。
コードをチャットに出して user が開くまでの数分が待ち受け時間を超える。

- **巻き添えは無い**: 失敗しても既存トークンは壊れない（`gh auth status` は ✓ のまま／実測）
- TTY で実行すればブラウザが自動で開き GitHub 規定の待ち時間をフルに使えるので、
  **承認待ちが発生する操作は user のターミナルでやってもらう**

### ✗ `gh auth refresh -s <scope>` でスコープを足しても反映されない

refresh が書き込むのは **keyring 側**。`gh` が使うのは `GH_TOKEN` のままなので、
承認が成功しても実効スコープは増えない（増えるのは `Active account: false` の行だけ）。

**スコープを足す正しい順序**（例: `workflow`）:
1. `[Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'User')` → 新しいシェルを開く
2. `gh auth refresh --hostname github.com -s workflow` を TTY で実行して承認
3. `$t = (gh auth token).Trim(); [Environment]::SetEnvironmentVariable('GH_TOKEN', $t, 'User')`

## 認証の確認は status ではなく実測で

```
gh api user --jq '.login'                 # → <認証アカウント>
git ls-remote https://github.com/<owner>/<repo>.git | head -3
gh api repos/<owner>/<repo> --jq '.permissions.push'   # → true
```

## スコープ別にできること（2026-10-26 時点の実効スコープ = gist, read:org, repo）

| 操作 | 可否 |
|---|---|
| `git push` / `gh pr create` / `gh pr merge` / `gh api` | ✅ |
| `.github/workflows/` 配下を変更して push | ❌ `workflow` スコープが無い |

出典セッション: `1994efec-227f-418d-b6c6-b1b140ded93b`（2026-10-26）

## pr-land — PR の着地（2026-10-28 集計に基づく）

実測: `gh pr view/checks` 136回／25セッション、PR #1147 を5セッションが重複ポーリング。マージ拒否の手渡しから automerge ラベル方式へ収束した。出典: `~/.claude/skill-and-loop-redesign-20261028.md` §1。

1. 実行レーンの許可を先に確認する。push/PR/merge 禁止レーンでは PR を作らず、ラベルも付けず、その制約を報告する。Windows で gh の所在が不明なら `where gh`（PowerShell は `where.exe gh`）で確認し、無ければ PR 作成を前提とする文面を書かない。
2. レビュー済み・スコープ内・非破壊の PR は `gh pr edit <PR番号> --add-label automerge`。CI 緑で GitHub が自動 squash マージするため、手動ポーリングは不要。workflow/keyserve/secrets/fleet 等の手動レビュー対象にはラベルを付けない（ONBOARDING §1.21）。
3. 操作が許可されていて automerge ラベルを付けられない場合のみ、`gh pr checks <PR番号>` の全 green・変更のスコープ内・非破壊を確認して `gh pr merge <PR番号> --squash`。既存のレビュー付きツールは `node tools/pr-merge.mjs <PR番号>`。classifier 拒否時はカテゴリを1行報告し、別コマンドへの言い換え再試行はしない。
4. 着地確認時に `git fetch origin` で参照を更新し、`node tools/commit-landed.mjs <sha>` で読み戻す。`git merge-base --is-ancestor` 単独は squash を見落とすので確認手段に使わない。`commit-landed` は ancestor・merged PR・patch-id を照合する。未着地は未着地として記録し、手動ポーリングしない。

参照: [commit-landed.mjs](../tools/commit-landed.mjs)、[pr-merge.mjs](../tools/pr-merge.mjs)。元の認証・スコープ表は上記日付の実測であり、現在の権限は対象リポジトリへ直接照会する。
