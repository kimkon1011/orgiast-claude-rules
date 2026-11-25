import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseFrontmatter,
  openDatabase,
  importMemoryDirectory,
  queryMemories,
  listMemories,
  getStats,
  runCli
} from './memory-to-sqlite.mjs';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sqlite-test-'));
}

function removeTempDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

test('parseFrontmatter - parses valid frontmatter correctly', () => {
  const md = `---
name: test-memory
description: "A test description"
type: user
---
This is the body of the memory.
It spans multiple lines.
`;

  const parsed = parseFrontmatter(md);
  assert.equal(parsed.name, 'test-memory');
  assert.equal(parsed.description, 'A test description');
  assert.equal(parsed.type, 'user');
  assert.equal(parsed.body, 'This is the body of the memory.\nIt spans multiple lines.');
});

test('parseFrontmatter - throws on invalid frontmatter format', () => {
  assert.throws(() => parseFrontmatter('No frontmatter delimiters'), /Invalid frontmatter/);
  assert.throws(() => parseFrontmatter('---\nname: foo\nNo closing delimiter'), /Invalid frontmatter/);
});

test('importMemoryDirectory - empty DB import and MEMORY.md skip', () => {
  const tempDir = createTempDir();
  try {
    // Create MEMORY.md (index file to skip)
    fs.writeFileSync(path.join(tempDir, 'MEMORY.md'), '# Index file');

    // Create a valid memory file
    fs.writeFileSync(
      path.join(tempDir, 'user-kim.md'),
      `---
name: user-kim
type: user
description: Kim user memory
---
Kim is operating this seat.
`
    );

    // Create another valid memory file
    fs.writeFileSync(
      path.join(tempDir, 'project-deckers.md'),
      `---
name: project-deckers
type: project
description: Deckers project
---
Deckers project memory details.
`
    );

    const result = importMemoryDirectory(tempDir);
    assert.equal(result.scanned, 3);
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.errors, 0);

    const dbPath = path.join(tempDir, 'memory.sqlite');
    const items = listMemories(dbPath);
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map(i => i.name).sort(),
      ['project-deckers', 'user-kim']
    );
  } finally {
    removeTempDir(tempDir);
  }
});

test('importMemoryDirectory - upsert (update existing name, preserve created_at)', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'memory.sqlite');
  try {
    const file1 = path.join(tempDir, 'test-item.md');
    fs.writeFileSync(
      file1,
      `---
name: test-item
type: general
description: Initial description
---
Initial body content.
`
    );

    importMemoryDirectory(tempDir);

    const initialResults = queryMemories(dbPath, 'Initial');
    assert.equal(initialResults.length, 1);
    const initialRecord = initialResults[0];
    const initialCreatedAt = initialRecord.created_at;
    const initialUpdatedAt = initialRecord.updated_at;

    // Small delay to ensure timestamp changes if updated
    await new Promise(res => setTimeout(res, 20));

    // Update file content
    fs.writeFileSync(
      file1,
      `---
name: test-item
type: general
description: Updated description
---
Updated body content with new info.
`
    );

    importMemoryDirectory(tempDir);

    const updatedResults = queryMemories(dbPath, 'Updated');
    assert.equal(updatedResults.length, 1);
    const updatedRecord = updatedResults[0];

    assert.equal(updatedRecord.description, 'Updated description');
    assert.equal(updatedRecord.body, 'Updated body content with new info.');
    assert.equal(updatedRecord.created_at, initialCreatedAt, 'created_at should be preserved');
    assert.notEqual(updatedRecord.updated_at, initialUpdatedAt, 'updated_at should be updated');
  } finally {
    removeTempDir(tempDir);
  }
});

test('FTS5 search test', () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'memory.sqlite');
  try {
    fs.writeFileSync(
      path.join(tempDir, 'acc1.md'),
      `---
name: acc1
type: feedback
description: Account facts memory
---
Local OAuth settings and credentials for account cr.
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'acc2.md'),
      `---
name: acc2
type: feedback
description: General feedback
---
This is unrelated text about printers.
`
    );

    importMemoryDirectory(tempDir);

    const results = queryMemories(dbPath, 'OAuth');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'acc1');

    const noResults = queryMemories(dbPath, 'nonexistentterm123');
    assert.equal(noResults.length, 0);
  } finally {
    removeTempDir(tempDir);
  }
});

test('Skipping malformed frontmatter files', () => {
  const tempDir = createTempDir();
  try {
    fs.writeFileSync(
      path.join(tempDir, 'bad.md'),
      `Malformed content with no frontmatter delimiters`
    );
    fs.writeFileSync(
      path.join(tempDir, 'good.md'),
      `---
name: good-memory
type: feedback
description: Good memory
---
Valid content.
`
    );

    const result = importMemoryDirectory(tempDir);
    assert.equal(result.scanned, 2);
    assert.equal(result.imported, 1);
    assert.equal(result.errors, 1);
  } finally {
    removeTempDir(tempDir);
  }
});

test('Modes - --query, --list, --stats CLI modes', () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'memory.sqlite');
  try {
    fs.writeFileSync(
      path.join(tempDir, 'm1.md'),
      `---
name: m1
type: user
description: Desc 1
---
Body 1 searchterm_unique
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'm2.md'),
      `---
name: m2
type: project
description: Desc 2
---
Body 2
`
    );

    importMemoryDirectory(tempDir);

    // List mode
    const list = listMemories(dbPath);
    assert.equal(list.length, 2);

    // Stats mode
    const stats = getStats(dbPath);
    assert.equal(stats.total, 2);
    assert.equal(stats.by_type.user, 1);
    assert.equal(stats.by_type.project, 1);

    // Query mode
    const qResults = queryMemories(dbPath, 'searchterm_unique');
    assert.equal(qResults.length, 1);
    assert.equal(qResults[0].name, 'm1');
  } finally {
    removeTempDir(tempDir);
  }
});
