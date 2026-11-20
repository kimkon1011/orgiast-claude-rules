# orgiast-claude-rules エージェントブートストラップ

> **更新**: 2026-11-20  
> **対象**: AI コーディングエージェント（Claude Code, Codex, Gemini CLI 等）が 018 のリポジトリで作業を開始するための初期化手順

## ブートストラップの目的

エージェントが以下の状態を 100% 把握してから開発に入る:
1. **リポジトリの正体**（何のリポジトリか、正本はどこか）
2. **ディレクトリ構造**（コードマップ）
3. **テストの実行方法**（緑の状態を確認）
4. **作業のエントリポイント**（今何をすべきか）
5. **制約とルール**（やってはいけないこと）

## ブートストラップ手順

### Step 1: リポジトリの正体を把握する

```sh
# リモート確認
git remote -v
# → origin: https://github.com/kimkon1011/orgiast-claude-rules.git
# → 正本: Google Drive ハブ claude-common-rules (folder 1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw)

# 最終commit確認
git log --oneline -1

# ブランチ確認
git branch -a | head -20
```

### Step 2: コードマップを読む

`docs/code-map.md` を読み、リポジトリ全体の構成を把握する。

**重要ディレクトリ**:
- `tools/` — 1635ファイルの実装コード（MJS + テスト）
- `skills/` — Claude Code スキル定義
- `config/` — JSON 設定
- `docs/` — AIニュース提案・設計文書
- `.claude/` — Claude Code 設定・エージェント定義

### Step 3: テストを実行して環境を確認する

```sh
# 全テスト実行（時間がかかる場合は最初の10件だけ）
node --test tools/*.test.mjs 2>&1 | tail -20

# 特定カテゴリのテスト
node --test tools/*-guard.test.mjs tools/*-gate.test.mjs 2>&1 | tail -10
```

**緑であるべきこと**: 全てのテストが PASS。RED の場合は先に修正してから着手。

### Step 4: 引き継ぎ情報を確認する

```sh
# セッション引き継ぎ
cat ~/.claude/next-session.md 2>/dev/null | head -30

# 最新の実行サマリ
ls -t runs/*.md 2>/dev/null | head -3 | while read f; do echo "=== $f ==="; head -20 "$f"; done

# 保留中の PR
gh pr list --state open --limit 10 2>/dev/null
```

### Step 5: key 設定ファイルを確認する

```sh
# レーン状態
cat config/lane-guard.json 2>/dev/null | head -20

# 鍵所有者
cat config/ai-key-owners.json 2>/dev/null | head -10

# 外部送信許可
cat config/external-send-registry.json 2>/dev/null | head -20
```

## 作業のエントリポイント

| 状況 | 最初に読むもの |
|------|---------------|
| **新規セッション開始** | `~/.claude/next-session.md` + `runs/` 最新サマリ |
| **既存バグ修正** | `tools/*.test.mjs` の RED テストを確認 |
| **新規ツール追加** | `tools/` の既存 `.mjs` をテンプレートに |
| **新規スキル追加** | `skills/existing/SKILL.md` をテンプレートに |
| **AIニュース提案** | `docs/ai-news-x*.md` を参照 → `pr-body-x*.md` 作成 |
| **ゲート修正** | `tools/*-gate.mjs` + `tools/*-guard.mjs` のペアを確認 |

## 絶対ルール（このリポジトリ専用）

1. **テストなしコミット禁止**: ツール変更時は必ず `node --test tools/<name>.test.mjs` が緑であることを確認してからコミット
2. **`git add -A` 禁止**: 自分が作成・変更したファイルだけをパス指定で add
3. **Codex 委譲**: 実装は `tools/codex-do.mjs` 経由で委譲。監督（Claude）は設計・レビュー・検証のみ
4. **正本は Drive**: GitHub はミラー。ルール変更は Drive ハブが正本 → 同期
5. **型で直す**: 不具合は `protocols/INCIDENT-TYPES.md` に型登録 → 同型横断修正 → ゲート追加
6. **PR は自分で着地**: `tools/pr-land.mjs` で base へ push しマージまで行う
7. **`git stash` / `git checkout -- .` 禁止**: 作業ツリーを共有している可能性があるため
8. **`.claude/settings.json` の編集は無断 OK**: バックアップを作成してから

## このリポジトリにおける典型的な作業フロー

```
1. ブートストラップ（本ファイル）→ リポジトリ構造を把握
2. テスト実行（node --test tools/*.test.mjs）→ 現状の緑を確認
3. 引き継ぎ情報確認（next-session.md, runs/最新）
4. 作業ブランチ作成（auto/YYYYMMDD-<slug>）
5. 実装（tools/codex-do.mjs 経由で委譲）
6. テスト緑確認 + 型チェック
7. PR作成 → pr-land.mjs で着地
8. 変更が実際に効いているか検証（本番経路で確認）
9. サマリ更新 + 次セッションへ引き継ぎ

所要時間目安: 新規ツール追加で 15〜30分、ゲート修正で 10〜20分
```

## 環境情報

| 項目 | 値 |
|------|-----|
| OS | Windows 10 Pro 10.0.19045 |
| Node.js | 最新安定版（nightly-repo 準拠） |
| パッケージ | playwright-core, postgres |
| Shel | bash（Git Bash） |
| 正本パス | `~/.claude/nightly-repo/` |
| 作業ディレクトリ | `auto-session-repo-fallback-*/` または worktree |
| PC識別子 | 018（DESKTOP-2D0R4LI） |