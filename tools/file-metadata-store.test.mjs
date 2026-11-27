import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, indexFile, searchFiles, indexDirectory, recentFiles, staleFiles, stats, runCli } from './file-metadata-store.mjs';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-meta-test-'));
}

function removeTempDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

test('openDatabase - creates tables and triggers', () => {
  const tmpDir = createTempDir();
  try {
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const db = openDatabase(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map(t => t.name);
    assert.ok(tableNames.includes('file_metadata'));
    assert.ok(tableNames.includes('file_metadata_fts'));

    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all();
    const triggerNames = triggers.map(t => t.name);
    assert.ok(triggerNames.includes('file_metadata_ai'));
    assert.ok(triggerNames.includes('file_metadata_ad'));
    assert.ok(triggerNames.includes('file_metadata_au'));
    db.close();
  } finally {
    removeTempDir(tmpDir);
  }
});

test('indexFile - indexes a single file and search finds it', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    const testFile = path.join(tmpDir, 'hello.mjs');
    fs.writeFileSync(testFile, 'export const greet = () => "hello";', 'utf8');
    const ok = indexFile(testFile, { dbPath });
    assert.ok(ok, 'indexFile should return true');

    const results = searchFiles('hello', { dbPath });
    assert.ok(results.length >= 1, 'should find indexed file');
    assert.ok(results.some(r => r.name === 'hello.mjs'), 'should match name');
  } finally {
    removeTempDir(tmpDir);
  }
});

test('indexFile - returns false for missing file', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    const ok = indexFile(path.join(tmpDir, 'nonexistent.mjs'), { dbPath });
    assert.equal(ok, false);
  } finally {
    removeTempDir(tmpDir);
  }
});

test('indexDirectory - indexes multiple files with kind filter', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Readme', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"a":1}', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'lib.mjs'), 'export const x = 1;', 'utf8');

    const result = indexDirectory(tmpDir, { dbPath });
    assert.ok(result.indexed >= 3, 'should index multiple files');
    assert.equal(result.errors, 0, 'should have no errors');

    const codeFiles = searchFiles('', { kind: 'code', dbPath });
    assert.ok(codeFiles.length >= 1, 'should find code files');
  } finally {
    removeTempDir(tmpDir);
  }
});

test('indexDirectory - glob pattern filters files', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    fs.writeFileSync(path.join(tmpDir, 'a.mjs'), 'code', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'b.md'), '# doc', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'c.json'), '{}', 'utf8');

    const result = indexDirectory(tmpDir, {
      dbPath,
      globPatterns: ['*.mjs', '*.md']
    });
    assert.equal(result.indexed, 2, 'should only index matching glob');
    assert.ok(result.skipped >= 1, 'should skip non-matching files (system files may add)');
  } finally {
    removeTempDir(tmpDir);
  }
});

test('searchFiles - filters by ext and kind', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    fs.writeFileSync(path.join(tmpDir, 'script.mjs'), 'export const x = 1;', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'doc.md'), '# Doc', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'config.env'), 'KEY=val', 'utf8');

    indexDirectory(tmpDir, { dbPath });

    const mdFiles = searchFiles('', { ext: '.md', dbPath });
    assert.equal(mdFiles.length, 1);
    assert.equal(mdFiles[0].name, 'doc.md');

    const codeFiles = searchFiles('', { kind: 'code', dbPath });
    assert.equal(codeFiles.length, 1);
    assert.equal(codeFiles[0].name, 'script.mjs');
  } finally {
    removeTempDir(tmpDir);
  }
});

test('searchFiles - FTS5 query finds files by path', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    fs.writeFileSync(path.join(tmpDir, 'cool-utils.mjs'), 'export const y = 2;', 'utf8');
    indexDirectory(tmpDir, { dbPath });

    const results = searchFiles('cool', { dbPath });
    assert.ok(results.length >= 1);
  } finally {
    removeTempDir(tmpDir);
  }
});

test('recentFiles - returns recently modified files', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    fs.writeFileSync(path.join(tmpDir, 'recent.mjs'), 'export const z = 3;', 'utf8');
    indexDirectory(tmpDir, { dbPath });

    const recent = recentFiles({ days: 1, dbPath });
    assert.ok(recent.length >= 1);
    assert.ok(recent.every(f => f.name));
  } finally {
    removeTempDir(tmpDir);
  }
});

test('staleFiles - returns array of files not modified recently', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    fs.writeFileSync(path.join(tmpDir, 'stale-test.mjs'), 'export const s = 4;', 'utf8');
    indexDirectory(tmpDir, { dbPath });

    const stale = staleFiles({ olderThanDays: 0, dbPath });
    assert.ok(Array.isArray(stale));
  } finally {
    removeTempDir(tmpDir);
  }
});

test('stats - returns summary with total, by_kind, total_tokens', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    fs.writeFileSync(path.join(tmpDir, 'code1.mjs'), 'export const a = 1;', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'code2.mjs'), 'export const b = 2;', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'doc1.md'), '# Doc', 'utf8');

    indexDirectory(tmpDir, { dbPath });

    const s = stats(dbPath);
    assert.ok(s.total >= 3);
    assert.ok(s.by_kind);
    assert.ok(s.by_kind.code >= 2);
    assert.ok(s.by_kind.doc >= 1);
    assert.ok(s.total_tokens > 0);
    assert.ok(s.db_size > 0);
  } finally {
    removeTempDir(tmpDir);
  }
});

test('stats - returns zeros for missing database', () => {
  const s = stats('/nonexistent/path/meta.sqlite');
  assert.equal(s.total, 0);
  assert.deepEqual(s.by_kind, {});
  assert.equal(s.total_tokens, 0);
  assert.equal(s.db_size, 0);
});

test('searchFiles - skip directory in index (check no errors)', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    fs.mkdirSync(path.join(tmpDir, 'emptydir'));
    const result = indexDirectory(tmpDir, { dbPath });
    // System files (desktop.ini) may exist on Windows; just verify no errors
    assert.equal(result.errors, 0);
  } finally {
    removeTempDir(tmpDir);
  }
});

test('searchFiles - returns empty array for missing database', () => {
  const results = searchFiles('test', { dbPath: '/nonexistent/test.sqlite' });
  assert.deepEqual(results, []);
});

test('recentFiles - returns empty array for missing database', () => {
  const results = recentFiles({ dbPath: '/nonexistent/test.sqlite' });
  assert.deepEqual(results, []);
});

test('staleFiles - returns empty array for missing database', () => {
  const results = staleFiles({ dbPath: '/nonexistent/test.sqlite' });
  assert.deepEqual(results, []);
});

test('kind estimation via extKind table', () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, 'test.sqlite');
  try {
    fs.writeFileSync(path.join(tmpDir, 'f.py'), 'x = 1', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'f.go'), 'package main', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'f.yaml'), 'key: val', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'f.ps1'), 'Write-Host hi', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'f.sh'), 'echo hi', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'f.unknown'), '???', 'utf8');

    indexDirectory(tmpDir, { dbPath });
    const s = stats(dbPath);
    // Our 6 files should be detected; system files may add 'other'
    assert.ok(s.by_kind.code >= 2, 'py and go should be code');
    assert.ok(s.by_kind.config >= 1, 'yaml should be config');
    assert.ok(s.by_kind.script >= 2, 'ps1 and sh should be script');
    assert.ok(s.by_kind.other >= 1, 'unknown ext should be other');
    assert.ok(s.total >= 6, 'should have at least 6 files');
  } finally {
    removeTempDir(tmpDir);
  }
});