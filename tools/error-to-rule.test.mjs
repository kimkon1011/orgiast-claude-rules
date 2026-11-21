import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = path.resolve(import.meta.dirname, 'error-to-rule.mjs');

function runTool(args) {
  try {
    const proc = spawnSync(process.execPath, [TOOL, ...args], { timeout: 10000, encoding: 'utf8' });
    return { status: proc.status, stdout: (proc.stdout ?? '').trim(), stderr: (proc.stderr ?? '').trim() };
  } catch (e) {
    return { status: -1, stdout: '', stderr: e.message };
  }
}

// テスト用のテンポラリルールファイルをセットアップ（同期版: cleanup は test の t.after を使わないので呼出元管理）
function createFixtureDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-to-rule-'));
  const rulesDir = path.join(tmpDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  const rulesContent = `---
paths:
  - "**/*.mjs"
---

# エラー由来Lintルール（テスト用）

## ルール一覧

### R001: テストルール1
- **発火条件**: 条件1
- **修正**: 修正1
- **テスト**: テスト1
- **初出**: 2026-11-01

## 登録手順

\`\`\`bash
node tools/error-to-rule.mjs --capture --title "..."
\`\`\`
`;
  fs.writeFileSync(path.join(rulesDir, 'error-lint-rules.md'), rulesContent, 'utf-8');
  return tmpDir;
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── バリデーション ────────────────────────────────────────

test('--validate が正常ルールに対して status: valid を返す', () => {
  const result = runTool(['--validate']);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 'valid');
  assert.equal(out.rulesFile, 'rules/error-lint-rules.md');
});

test('--list がルール一覧を出力する', () => {
  const result = runTool(['--list']);
  const out = JSON.parse(result.stdout);
  assert(Array.isArray(out));
  assert(out.length > 0);
  assert(out[0].id);
  assert(out[0].title);
});

test('--list に既知のルールIDが含まれる', () => {
  const result = runTool(['--list']);
  const out = JSON.parse(result.stdout);
  const ids = out.map(r => r.id);
  assert(ids.includes('R001'));
});

test('新規ルールを --capture --dry-run で登録せずプレビュー', () => {
  const fixture = createFixtureDir();
  try {
    const result = runTool(['--capture', '--title', 'テストルール新規', '--file', 'test.mjs', '--pattern', 'TODO', '--dry-run', '--cwd', fixture]);
    const out = JSON.parse(result.stdout);
    assert.equal(out.id, 'R002');
    assert.equal(out.title, 'テストルール新規');
    assert(out.dryRun === true);
  } finally {
    cleanupDir(fixture);
  }
});

test('新規ルールを --capture で登録するとファイルに追記される', () => {
  const fixture = createFixtureDir();
  try {
    const result = runTool(['--capture', '--title', '実ルール登録', '--file', 'example.mjs', '--pattern', 'BAD_PATTERN', '--cwd', fixture]);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'registered');
    assert.equal(out.id, 'R002');

    const content = fs.readFileSync(path.join(fixture, 'rules', 'error-lint-rules.md'), 'utf-8');
    assert(content.includes('R002: 実ルール登録'));
    assert(content.includes('BAD_PATTERN'));
  } finally {
    cleanupDir(fixture);
  }
});

test('ルールのIDは最大値+1で採番される', () => {
  const fixture = createFixtureDir();
  try {
    runTool(['--capture', '--title', 'ルールA', '--cwd', fixture]);
    const result2 = runTool(['--capture', '--title', 'ルールB', '--cwd', fixture]);
    const out2 = JSON.parse(result2.stdout);
    assert.equal(out2.id, 'R003');
  } finally {
    cleanupDir(fixture);
  }
});

test('必須オプション --title 無しはエラー終了する', () => {
  const result = runTool(['--capture']);
  // stdout に JSON error が出力される
  if (result.stdout) {
    const out = JSON.parse(result.stdout);
    assert(out.error !== undefined);
  } else {
    // エラーは stderr にも出る可能性
    assert(result.status !== 0 || result.stderr.length > 0);
  }
});

test('--export-json が全ルールをJSON配列で出力する', () => {
  const result = runTool(['--export-json']);
  const out = JSON.parse(result.stdout);
  assert(Array.isArray(out));
  assert(out.length > 0);
  assert(out[0].id);
  assert(out[0].title);
  assert('trigger' in out[0]);
  assert('fix' in out[0]);
});

test('存在しないルールIDを --search するとエラーを返す', () => {
  const result = runTool(['--search', 'R999']);
  if (result.stdout) {
    const out = JSON.parse(result.stdout);
    assert(out.error !== undefined);
    assert(out.error.includes('R999'));
  } else {
    assert(result.status !== 0);
  }
});

test('バリデーションで重複IDを検出する', () => {
  const fixture = createFixtureDir();
  try {
    const dupContent = `---
paths:
  - "**/*.mjs"
---

# テスト（重複ID）

## ルール一覧

### R001: ルール1
- **発火条件**: 条件1
- **修正**: 修正1
- **テスト**: テスト1
- **初出**: 2026-11-01

### R001: ルール2（重複）
- **発火条件**: 条件2
- **修正**: 修正2
- **テスト**: テスト2
- **初出**: 2026-11-02

## 登録手順

\`\`\`bash
node tools/error-to-rule.mjs --validate
\`\`\`
`;
    fs.writeFileSync(path.join(fixture, 'rules', 'error-lint-rules.md'), dupContent, 'utf-8');
    const result = runTool(['--validate', '--cwd', fixture]);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'invalid');
    assert(out.issues.some(i => i.type === 'duplicate_id' && i.id === 'R001'));
  } finally {
    cleanupDir(fixture);
  }
});