import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function readVscodeHiddenSessionIds({ env = process.env, fsImpl = fs, openDb } = {}) {
  const ids = new Set();
  const appData = env?.APPDATA || (env?.HOME ? path.join(env.HOME, 'AppData', 'Roaming') : path.join(os.homedir(), 'AppData', 'Roaming'));
  const dbPath = path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb');

  const exists = fsImpl?.existsSync ?? fs.existsSync;
  if (!exists(dbPath)) {
    return { ids, error: `state.vscdb not found at ${dbPath}` };
  }

  let tmpDir = null;
  try {
    const tmpBase = os.tmpdir();
    const mkdtemp = fsImpl?.mkdtempSync ?? fs.mkdtempSync;
    tmpDir = mkdtemp(path.join(tmpBase, 'vscode-hidden-'));
    const tmpPath = path.join(tmpDir, 'state.vscdb');

    const copy = fsImpl?.copyFileSync ?? fs.copyFileSync;
    copy(dbPath, tmpPath);

    let rows = [];
    if (typeof openDb === 'function') {
      const dbObj = openDb(tmpPath);
      if (dbObj && typeof dbObj.prepare === 'function') {
        rows = dbObj.prepare('SELECT key, value FROM ItemTable').all();
        if (typeof dbObj.close === 'function') dbObj.close();
      } else if (Array.isArray(dbObj)) {
        rows = dbObj;
      }
    } else {
      const db = new DatabaseSync(tmpPath);
      try {
        db.exec('PRAGMA query_only = 1');
      } catch {}
      rows = db.prepare('SELECT key, value FROM ItemTable').all();
      db.close();
    }

    for (const row of rows) {
      if (row?.key === 'Anthropic.claude-code') {
        let parsed;
        try {
          parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        } catch (e) {
          return { ids, error: `Invalid JSON in Anthropic.claude-code: ${e.message}` };
        }
        if (parsed && Array.isArray(parsed.hiddenSessionIds)) {
          for (const id of parsed.hiddenSessionIds) {
            if (typeof id === 'string' && id) ids.add(id);
          }
        }
        break;
      }
    }

    return { ids, error: null };
  } catch (err) {
    return { ids, error: err.message };
  } finally {
    if (tmpDir) {
      try {
        const rm = fsImpl?.rmSync ?? fs.rmSync;
        rm(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
