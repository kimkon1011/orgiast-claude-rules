---
paths:
  - "**/*.mjs"
  - "**/*.js"
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.gs"
  - "**/*.ps1"
---

# エラー由来Lintルール（Error-to-Lint-Rule Registry）

過去のコーディングエラー・インシデントから抽出した、機械検証可能なルール。
新たなエラーが発生したら `node tools/error-to-rule.mjs --capture` で登録する。

## ルール一覧

### R001: 標準ライブラリの関数名 typo 禁止
- **発火条件**: `os.homedir` / `fs.existsSync` / `path.join` / `fs.readdirSync` など、存在しない stdlib 関数を呼んでいる
- **修正**: 正しい API 名を確認する（`os.homedir()` → `os.homedir()`（正） or `require('node:os').homedir`）
- **テスト**: 該当モジュールの import 後、全呼出を `node -e "import ... "` で構文＋名前解決確認
- **初出**: 2026-10-09 gate-without-remedy.md — 関数名を誤ってもエラーにならず、別の経路から暗黙の undefined が返る
- **参考インシデント**: tools 配下の複数ファイルで `fs.existsSync` → `fs.existsSync`（正: `fs.existsSync`）、`os.homedir` → `os.homedir`（正: `os.homedir`）

### R002: 非同期関数の同期呼出禁止
- **発火条件**: `await` が必要な関数呼出に `await` が無い / `Sync` 接尾辞の無い関数を同期文脈で呼んでいる
- **修正**: `await` を付けるか、同期版（`readFileSync`/`writeFileSync` 等）に置き換える
- **テスト**: `grep -n 'fs\.\(readFile\|writeFile\|mkdir\|rm\|copyFile\)[^S]'` で非同期呼出を検出し、呼出元が非同期関数か確認
- **初出**: 2026-10-15

### R003: エラーハンドリングの空キャッチ禁止
- **発火条件**: `catch { /* 何もしない */ }` / `catch {}` / `catch(e) {}` — 空の catch ブロックでエラーを握りつぶしている
- **修正**: 最低でもログ出力（`console.error`）を入れる。握りつぶし意図なら `// skip: <理由>` のコメント必須
- **テスト**: `grep -n '^\s*catch\s*\(\s*\w*\s*\)\s*\{\s*\}'` または `catch\s*\{\s*\}` で空ブロック検出
- **初出**: 2026-10-26 stalled-resume-no-executor.md

### R004: キャッシュ前提の経路判断禁止
- **発火条件**: ファイル・API レスポンスの不在を「システム全体が未対応」と断定している
- **修正**: 外部状態は常に直接照会して判断する（`readFileSync` で確認、API を叩く）
- **テスト**: 「存在しない」「使えない」「未対応」というエラーメッセージを投げる catch 節で、その前に確認のための照会をしているか grep
- **初出**: 2026-07-04 external-state-claim-gate

### R005: 固定パスの作業ツリー依存禁止
- **発火条件**: コード内に `C:\Users\...` の絶対パス / 作業者のホーム直書きがある
- **修正**: `os.homedir()` / `process.env.ORGIAST_HOME` / `import.meta.dirname` を使う
- **テスト**: `grep -rn 'C:\\\\Users\\\\'` またはハードコードされた絶対パスを検出
- **初出**: 2026-10-20 spawn_failed 6件 — WSL 経路でバックスラッシュが解釈不能

### R006: exit コード単独での成功判定禁止
- **発火条件**: 子プロセスの exit code 0 のみで「成功」と判断し、stdout/stderr を無視している
- **修正**: exit code + stdout 内容 + stderr 有無の3点で成功判定する。`spawnSync` の `status` だけで判断しない
- **テスト**: `.status === 0` または `.exitCode === 0` で成否判定している箇所で、出力内容の検証があるか確認
- **初出**: 2026-11-06 — auto-progress が node の crash exit 1 を「未達」と誤判定

### R007: マジックナンバーの定数化必須
- **発火条件**: コード中に説明無しのマジックナンバー（数値リテラル）が出現している
- **修正**: 名前付き定数として定義し、使用箇所でその定数を参照する
- **テスト**: 関数内外で説明なしの数値リテラルを検出
- **初出**: 2026-11-01 — タイムアウト値30000を直書きし、修正時に全 grep が必要に

### R008: 完了報告の「検証済み」は実データの読み戻し必須
- **発火条件**: 「完了しました」「登録しました」「更新しました」と主張しながら、実データの読み戻し（read-back）を行っていない
- **修正**: 書き込み操作後は必ず `readFileSync` / API GET / 画面再取得で実値を確認する
- **テスト**: 主張と read-back の対が同一関数内に存在するか
- **初出**: 2026-10-09 — GAS deploy 後確認せず「完了」報告

### R009: エラーログの秘匿ハッシュ衝突防止
- **発火条件**: `dedupeKey` 等の重複排除キーを `[REDACTED]` で一律置換している
- **修正**: 機密値のハッシュは安定した部分ダイジェストを使い、完全一致の REDACTED 置換は避ける
- **テスト**: ログや重複排除キー生成箇所で `REDACTED` が値として使われていないか
- **初出**: 2026-11-13 — エイト様 LINE 通知の dedupeKey が一律 REDACTED で誤集約

### R010: レスポンス型（schemas）の明示必須
- **発火条件**: LLM 出力を `JSON.parse` する際に、事前の型定義・schema 検証を経由していない
- **修正**: パース前に zod / assertion 関数で構造検証し、不全時は fallback / retry 処理を入れる
- **テスト**: `JSON.parse` の呼出元で受け取り型の検証があるか
- **初出**: 2026-11-06 — ai-news-triage で JSON 復旧ロジックが複数回改修

### R011: ブランチ名の意味明確化
- **発火条件**: `fix/` `feat/` 等の prefix 無し / 変更内容と無関係なブランチ名
- **修正**: `auto/YYYYMMDD-短いスラグ` 形式を基本とし、内容を表すスラグを付ける
- **テスト**: ブランチ名パターンチェック
- **初出**: REPO 標準

## 登録手順（新規エラー発生時）

1. **エラーを記録**:
   ```bash
   node tools/error-to-rule.mjs --capture --title "<簡潔なルール名>" --file "<エラーが発生したファイル>" --pattern "<検出パターン（grep可）>"
   ```

2. **ルールを登録**: 上記コマンドで本ファイルにルールが追記される。

3. **テストを追加**: `tools/error-to-rule.test.mjs` のルール一覧に新しいルール ID を追加する。

4. **横展開**: 同じパターンが他に無いか `grep` で確認し、見つかったら同じ PR で修正する。

## 検証コマンド

```bash
# 全ルールの整合性チェック（ID重複・frontmatter）
node tools/error-to-rule.mjs --validate

# 特定ルールの違反箇所を検索
node tools/error-to-rule.mjs --search R001

# 新規ルールを対話的に登録（簡易版）
node tools/error-to-rule.mjs --capture --interactive
```