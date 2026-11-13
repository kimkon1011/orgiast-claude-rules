#!/usr/bin/env node
/**
 * Read VS Code state DBs and output parsed tab state as JSON to stdout.
 *
 * Usage: node read-tab-state.mjs <workspaceStorageDir> <globalStorageDir> <homeDir>
 *
 * - workspaceStorageDir: dir containing state.vscdb (the hash dir under workspaceStorage/)
 * - globalStorageDir:    dir containing state.vscdb (Code/User/globalStorage/)
 * - homeDir:             user home (~), for reading ~/.claude/closed-sessions.json
 *
 * Output: { tabs, hiddenSessionIds, closedSessionIds }
 *   tabs[]             — parsed from editor memento via parseEditorMemento
 *   hiddenSessionIds[] — from VS Code global state ("Anthropic.claude-code".hiddenSessionIds)
 *   closedSessionIds[] — from ~/.claude/closed-sessions.json ids
 *
 * Each state.vscdb is copied to a temp dir before opening to avoid locking.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, copyFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let parseEditorMementoFn;
try {
  parseEditorMementoFn = require('./tab-sessions.cjs').parseEditorMemento;
} catch {
  // fallback when run from a different cwd
  parseEditorMementoFn = null;
}

function warn(msg) { process.stderr.write(`read-tab-state: ${msg}\n`); }

/** Copy a SQLite DB to temp and open read-only. Returns { db, cleanup } or null. */
function openDbCopy(dbPath) {
  if (!existsSync(dbPath)) return null;
  const tmpDir = mkdtempSync(join(tmpdir(), 'vscode-db-'));
  const tmpPath = join(tmpDir, 'state.vscdb');
  try {
    copyFileSync(dbPath, tmpPath);
    const db = new DatabaseSync(tmpPath);
    // Enable WAL-mode reads even though it's a copy
    db.exec('PRAGMA query_only = 1');
    return {
      db,
      rows: db.prepare('SELECT key, value FROM ItemTable').all(),
      cleanup() { try { db.close(); } catch {} try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} },
    };
  } catch (err) {
    warn(`openDbCopy(${dbPath}) error: ${err.message}`);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return null;
  }
}

function main() {
  const [workspaceStorageDir, globalStorageDir, homeDir] = process.argv.slice(2);
  if (!workspaceStorageDir || !globalStorageDir || !homeDir) {
    warn('Usage: read-tab-state.mjs <workspaceStorageDir> <globalStorageDir> <homeDir>');
    process.exit(1);
  }

  // 1. Workspace storage — read editor memento
  let rawMemento = null;
  const wsDb = openDbCopy(join(workspaceStorageDir, 'state.vscdb'));
  if (wsDb) {
    for (const row of wsDb.rows) {
      if (row.key === 'memento/workbench.parts.editor') {
        rawMemento = row.value;
        break;
      }
    }
    wsDb.cleanup();
  } else {
    warn(`workspace DB not found at ${join(workspaceStorageDir, 'state.vscdb')}`);
  }

  // 2. Global storage — read Claude Code extension state for hiddenSessionIds
  let hiddenSessionIds = [];
  const gsDb = openDbCopy(join(globalStorageDir, 'state.vscdb'));
  if (gsDb) {
    for (const row of gsDb.rows) {
      if (row.key === 'Anthropic.claude-code') {
        try {
          const cc = JSON.parse(row.value);
          if (Array.isArray(cc.hiddenSessionIds)) hiddenSessionIds = cc.hiddenSessionIds;
        } catch (e) { warn(`parse Anthropic.claude-code: ${e.message}`); }
        break;
      }
    }
    gsDb.cleanup();
  } else {
    warn(`global DB not found at ${join(globalStorageDir, 'state.vscdb')}`);
  }

  // 3. Closed sessions file
  let closedSessionIds = [];
  const closedPath = join(homeDir, '.claude', 'closed-sessions.json');
  if (existsSync(closedPath)) {
    try {
      const data = JSON.parse(readFileSync(closedPath, 'utf8'));
      if (Array.isArray(data.ids)) closedSessionIds = data.ids;
    } catch (e) { warn(`parse closed-sessions.json: ${e.message}`); }
  }

  // 4. Parse memento
  let tabs = [];
  if (rawMemento && parseEditorMementoFn) {
    try {
      tabs = parseEditorMementoFn(rawMemento);
    } catch (e) { warn(`parseEditorMemento: ${e.message}`); }
  }

  process.stdout.write(JSON.stringify({ tabs, hiddenSessionIds, closedSessionIds }) + '\n');
}

main();