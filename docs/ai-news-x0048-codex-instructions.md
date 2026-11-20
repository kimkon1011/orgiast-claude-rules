# Codex 実装指示: X-0048 Ninja キャッシュ読取コスト削減

## 全体注意
- テストは `node --test tools/*.test.mjs` が通ること
- エクスポートは `export` (ESM) 形式
- エラーハンドリングは try-catch で握りつぶさず throw/fail
- ファイルパスは SQLite の path UNIQUE 制約に対応するため、すべて path.resolve() してから格納
- IME環境: Windows Git Bash。node:sqlite の DatabaseSync を使用可能

## Item 1: tools/file-metadata-store.mjs

ファイル・ディレクトリのメタデータを SQLite FTS5 に格納し検索するツール。

既存の `tools/memory-to-sqlite.mjs` のパターンに従う（`import { DatabaseSync } from 'node:sqlite'` で同期的に使う）。

### SQLite スキーマ（openDatabase で自動作成）

```sql
CREATE TABLE IF NOT EXISTS file_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  ext TEXT,
  size INTEGER,
  modified_at TEXT,
  content_hash TEXT,
  token_estimate INTEGER,
  kind TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS file_metadata_fts USING fts5(path, name, content='file_metadata', content_rowid='id', tokenize='unicode61');
-- トリガー: INSERT/DELETE/UPDATE で FTS 同期
CREATE TRIGGER IF NOT EXISTS file_metadata_ai AFTER INSERT ...
CREATE TRIGGER IF NOT EXISTS file_metadata_ad AFTER DELETE ...
CREATE TRIGGER IF NOT EXISTS file_metadata_au AFTER UPDATE ...
```

- kind: 拡張子から推定。`code` (.mjs/.js/.ts/.py), `doc` (.md/.txt/.html), `data` (.json/.csv/.tsv), `config` (.jsonl/.env/.yaml/.yml), `other`
- token_estimate: `Math.ceil(Buffer.byteLength(text, 'utf8') / 3)`
- content_hash: SHA-256 先頭16桁
- modified_at: new Date(stat.mtimeMs).toISOString()

### API エクスポート

| 関数 | シグネチャ | 説明 |
|------|-----------|------|
| `openDatabase(dbPath)` | → DatabaseSync | DB初期化 + テーブル作成 |
| `indexDirectory(dir, {recursive, globPatterns, dbPath})` | → {scanned, indexed, skipped, errors} | ディレクトリを再帰スキャンし upsert。globPatterns がなければ全ファイル。`fs.readdirSync`+`fs.statSync` を使う |
| `indexFile(filePath, {dbPath})` | → boolean | 単一ファイルを upsert |
| `searchFiles(query, {kind, ext, limit, offset, dbPath})` | → [{path, name, ext, size, modified_at, kind, score}] | FTS5 MATCH query、kind/ext でフィルタ |
| `recentFiles({days, limit, dbPath})` | → [{path, name, ...}] | 直近 modified_at のファイル |
| `staleFiles({olderThanDays, limit, dbPath})` | → [{path, name, ...}] | 古いファイル |
| `stats(dbPath)` | → {total, by_kind, total_tokens, db_size} | |
| `runCli(args)` | → void | CLI エントリポイント |

### CLI

```
node tools/file-metadata-store.mjs index <dir> [--db <path>] [--glob <pattern>]
node tools/file-metadata-store.mjs search <query> [--db <path>] [--kind <k>] [--ext <e>] [--limit <n>]
node tools/file-metadata-store.mjs recent [--days <n>] [--db <path>] [--limit <n>]
node tools/file-metadata-store.mjs stale [--older-than <days>] [--db <path>] [--limit <n>]
node tools/file-metadata-store.mjs stats [--db <path>]
```

- `cli` 引数は `import { parseArgs } from 'node:util'` の `parseArgs` を使う。オプション解析は `memory-to-sqlite.mjs` の `runCli` と同様
- DB 既定パス: `~/.claude/file-metadata/meta.sqlite` (`os.homedir()`)
- 出力は table 形式（console.table 使用可）または JSON（--json フラグ）

### ファイル種別推定ロジック（kind）
```js
const extKind = {
  '.mjs': 'code', '.js': 'code', '.ts': 'code', '.tsx': 'code',
  '.py': 'code', '.rb': 'code', '.java': 'code', '.go': 'code',
  '.rs': 'code', '.c': 'code', '.h': 'code', '.cpp': 'code',
  '.md': 'doc', '.txt': 'doc', '.html': 'doc', '.htm': 'doc',
  '.json': 'data', '.csv': 'data', '.tsv': 'data',
  '.jsonl': 'config', '.env': 'config', '.yaml': 'config', '.yml': 'config',
  '.toml': 'config', '.ini': 'config', '.cfg': 'config',
  '.ps1': 'script', '.sh': 'script', '.bat': 'script',
  '.css': 'code', '.scss': 'code', '.xml': 'data',
  '.svg': 'doc', '.pdf': 'doc', '.png': 'other', '.jpg': 'other',
};
```

### FTS5 検索の注意
- `MATCH ?` のプレースホルダー方式。ユーザー入力の特殊文字（`*`, `"`, `(` etc.）はエスケープ or phrase query でラップ
- syntax error 時は `"query"` (phrase) にフォールバック（memory-to-sqlite.mjs と同様）

## Item 2: tools/batch-call-prompt.mjs

ツール呼出のバッチ化を促進する設定を出力するCLI。

### CLI

```
node tools/batch-call-prompt.mjs [--prompt-only] [--gate-only]
```

- `--prompt-only`: システムプロンプト追加文案だけ出力
- `--gate-only`: settings.json 用の hook 設定だけ出力
- 何も指定しないと両方出力

### 出力内容

1. **システムプロンプト文案**: CLAUDE.md の末尾または `docs/` 向けのMarkdown文案
   ```markdown
   ## ツール呼出のバッチ化
   コスト削減のため、複数の独立したツール呼出を1回のバッチ呼出にまとめられないか毎回検討すること:
   - 連続する Read は 1 回にまとめられないか（例: 3ファイル → Read 1回）
   - 同種の Grep は正規表現を結合し 1 回のパターンで済ませる
   - ファイル一覧は Glob 1 回で取得しプログラム側で絞り込む
   ```

2. **settings.json hook 設定**（CLAUDE.md に追記する形で出力）:
   ```json
   {
     "hooks": {
       "PostToolCall": {
         "command": "node tools/batch-call-gate.mjs --check"
       }
     }
   }
   ```

### エクスポート

```js
export function generatePrompt() → string  // プロンプト文案
export function generateGateConfig() → string  // settings.json 追記ブロック
export function runCli(args) → void
```

- テスト不要（内容は静的な文案のため）

## Item 3: tools/batch-call-gate.mjs（オプション・Item 2の付属）

セッション終了時にツール呼出パターンを分析し、バッチ化提案を出力するゲート。

### CLI: `node tools/batch-call-gate.mjs --check <logfile>`

JSONL のセッションログを読み、以下のパターンを検出:
- 同一ツール（Read/Glob/Grep）が 3 回以上連続している
- 間に他のツールやユーザーメッセージがない

出力:
```json
{"suggestions": [{"tool": "Read", "count": 5, "suggestion": "5回のReadを1回のGlobにまとめられます"}], "total": 1}
```

エクスポート:
```js
export function analyzeCalls(logEntries) → [{tool, count, suggestion}]
export function runCli(args) → void
```

既存の `tools/bulk-context-audit.mjs` のログ解析パターンを参考に実装。

## テストファイル: tools/file-metadata-store.test.mjs

テスト例（`node --test` 形式、各テストケースは `it("説明", () => { ... })` で記述）：

```js
import { openDatabase, indexFile, searchFiles, indexDirectory, stats } from './file-metadata-store.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// テンポラリディレクトリでテスト
const tmpDir = fs.mkdtempSync('file-meta-test-');
const dbPath = path.join(tmpDir, 'test.sqlite');
// tmpDir 内にテスト用ファイルを作成: a.mjs, b.md, c.json

export function testOpenAndIndex() {
  const db = openDatabase(dbPath);
  // 1. DB作成後、テーブル存在確認
  const tableCount = db.prepare("SELECT count(*) as n FROM sqlite_master WHERE type='table'").get();
  assert(tableCount.n >= 2, 'should create tables');
  db.close();
}

export function testIndexFile() {
  // テストファイル作成
  const testFile = path.join(tmpDir, 'hello.mjs');
  fs.writeFileSync(testFile, 'export const greet = () => "hello";', 'utf8');
  const ok = indexFile(testFile, { dbPath });
  assert(ok, 'indexFile should return true');
  // 検索で見つかる
  const results = searchFiles('hello', { dbPath });
  assert(results.length >= 1, 'should find indexed file');
  assert(results.some(r => r.name === 'hello.mjs'), 'should match name');
}

export function testIndexDirectory() {
  // テストファイル複数作成
  fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Readme', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"a":1}', 'utf8');
  fs.mkdirSync(path.join(tmpDir, 'sub'));
  fs.writeFileSync(path.join(tmpDir, 'sub', 'lib.mjs'), 'export const x = 1;', 'utf8');
  
  const result = indexDirectory(tmpDir, { dbPath });
  assert(result.indexed >= 3, 'should index multiple files');
  
  // kind でフィルタ検索
  const codeFiles = searchFiles('', { kind: 'code', dbPath });
  assert(codeFiles.length >= 1, 'should find code files');
}

export function testStats() {
  const s = stats(dbPath);
  assert(s.total >= 3, 'should show total count');
  assert(s.by_kind, 'should have kind breakdown');
}

export function testStaleFiles() {
  const stale = staleFiles({ olderThanDays: 0, dbPath });
  assert(Array.isArray(stale), 'should return array of stale files');
}

// クリーンアップ
export function cleanup() {
  fs.rmdirSync(tmpDir, { recursive: true });
}
```

## 完了条件
1. `tools/file-metadata-store.mjs` が実装され、`node tools/file-metadata-store.mjs --help` で使い方が表示される
2. `tools/batch-call-prompt.mjs` が実装され、`node tools/batch-call-prompt.mjs` でプロンプト文案とゲート設定が出力される
3. `tools/file-metadata-store.test.mjs` のテストが `node --test` で全件パスする
4. 既存テスト `node --test tools/*.test.mjs` が壊れていない（少なくとも冒頭50件が通る）
5. ブランチ `auto/20261115-ninja-cache-reduction` にコミットされ、PR が作られている

## 注意点
- `node --test` で全テストを通すこと。context-trim.test.mjs など既存テストも壊さないこと
- Windows Git Bash 環境対応: `path.join` を使い、`/` ハードコードしない
- 既存テストへの影響確認: `git -C "C:\Users\user\.claude\auto-session-repo" status --porcelain` で自分の変更ファイルだけが表示されることを確認
- コミットメッセージは以下の1行で（本文は空）:
  `feat(x0048): ninja sqlite metadata + batch-call-prompt (#2072)`
- コミットには attribution 行 `Co-Authored-By: Claude Code <noreply@anthropic.com>` を末尾に付ける
- `git add` は新しいファイルだけをパス指定で行う（git add -A 禁止）
- ブランチ名: `auto/20261115-ninja-cache-reduction`
- PRは `node tools/pr-land.mjs --title "feat(x0048): ninja sqlite metadata + batch-call-prompt (#2072)" --body-file <temp-body.md>` で着地させる。automerge ラベルを期待