#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.claude', 'file-metadata', 'meta.sqlite');

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

function estimateKind(ext) {
  return extKind[ext.toLowerCase()] || 'other';
}

function estimateTokenCount(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function computeHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function escapeFtsQuery(term) {
  if (!term || term.trim() === '') {
    return '';
  }
  // FTS5 special chars: ^ $ ( ) { } [ ] " * ? : ~ - + whitespace
  const special = /[(){}[\]"*?:~\-+^$]/g;
  const hasSpecial = special.test(term);
  if (hasSpecial) {
    // Escape as phrase query to avoid syntax errors
    return `"${term.replace(/"/g, '""')}"`;
  }
  return term;
}

function globToRegex(pattern) {
  let regexStr = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') regexStr += '.*';
    else if (ch === '?') regexStr += '.';
    else if (/[.+^${}()|[\]\\]/.test(ch)) regexStr += '\\' + ch;
    else regexStr += ch;
  }
  return new RegExp('^' + regexStr + '$', 'i');
}

/**
 * Initializes SQLite database and sets up file_metadata and FTS5 tables/triggers.
 * @param {string} dbPath
 * @returns {DatabaseSync}
 */
export function openDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  db.exec(`
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

    CREATE VIRTUAL TABLE IF NOT EXISTS file_metadata_fts USING fts5(
      path, name,
      content='file_metadata',
      content_rowid='id',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS file_metadata_ai AFTER INSERT ON file_metadata BEGIN
      INSERT INTO file_metadata_fts(rowid, path, name) VALUES (new.id, new.path, new.name);
    END;

    CREATE TRIGGER IF NOT EXISTS file_metadata_ad AFTER DELETE ON file_metadata BEGIN
      INSERT INTO file_metadata_fts(file_metadata_fts, rowid, path, name) VALUES('delete', old.id, old.path, old.name);
    END;

    CREATE TRIGGER IF NOT EXISTS file_metadata_au AFTER UPDATE ON file_metadata BEGIN
      INSERT INTO file_metadata_fts(file_metadata_fts, rowid, path, name) VALUES('delete', old.id, old.path, old.name);
      INSERT INTO file_metadata_fts(rowid, path, name) VALUES (new.id, new.path, new.name);
    END;
  `);

  return db;
}

/**
 * Indexes a single file into the metadata store.
 * @param {string} filePath - absolute path to the file
 * @param {{ dbPath?: string }} [options]
 * @returns {boolean}
 */
export function indexFile(filePath, options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`[ERROR] File not found: ${absPath}`);
    return false;
  }

  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    console.error(`[ERROR] Not a file: ${absPath}`);
    return false;
  }

  const name = path.basename(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const kind = estimateKind(ext);
  const modifiedAt = new Date(stat.mtimeMs).toISOString();
  const size = stat.size;

  let contentHash = '';
  let tokenEstimate = 0;

  if (size > 0) {
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      contentHash = computeHash(content);
      tokenEstimate = estimateTokenCount(content);
    } catch {
      // Binary or unreadable file — leave hash/estimate empty
    }
  }

  const db = openDatabase(dbPath);
  try {
    const upsert = db.prepare(`
      INSERT INTO file_metadata (path, name, ext, size, modified_at, content_hash, token_estimate, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        ext = excluded.ext,
        size = excluded.size,
        modified_at = excluded.modified_at,
        content_hash = excluded.content_hash,
        token_estimate = excluded.token_estimate,
        kind = excluded.kind
    `);
    upsert.run(absPath, name, ext, size, modifiedAt, contentHash, tokenEstimate, kind);
    return true;
  } finally {
    db.close();
  }
}

/**
 * Recursively indexes all files in a directory.
 * @param {string} dir - directory path
 * @param {{ recursive?: boolean, globPatterns?: string[], dbPath?: string }} [options]
 * @returns {{ scanned: number, indexed: number, skipped: number, errors: number }}
 */
export function indexDirectory(dir, options = {}) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) {
    console.error(`[ERROR] Directory not found: ${absDir}`);
    return { scanned: 0, indexed: 0, skipped: 0, errors: 1 };
  }

  const recursive = options.recursive !== false;
  const globPatterns = options.globPatterns || null;
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  let scanned = 0;
  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  const db = openDatabase(dbPath);

  const upsert = db.prepare(`
    INSERT INTO file_metadata (path, name, ext, size, modified_at, content_hash, token_estimate, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name,
      ext = excluded.ext,
      size = excluded.size,
      modified_at = excluded.modified_at,
      content_hash = excluded.content_hash,
      token_estimate = excluded.token_estimate,
      kind = excluded.kind
  `);

  try {
    function walk(currentDir) {
      let entries;
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (err) {
        console.error(`[ERROR] Cannot read directory ${currentDir}: ${err.message}`);
        errors++;
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (recursive && !entry.name.startsWith('.')) {
            walk(fullPath);
          }
          continue;
        }

        if (!entry.isFile()) continue;
        scanned++;

        if (globPatterns && globPatterns.length > 0) {
          const matches = globPatterns.some(pattern => {
            const regex = globToRegex(pattern);
            return regex.test(entry.name);
          });
          if (!matches) {
            skipped++;
            continue;
          }
        }

        try {
          const stat = fs.statSync(fullPath);
          const name = entry.name;
          const ext = path.extname(name).toLowerCase();
          const kind = estimateKind(ext);
          const modifiedAt = new Date(stat.mtimeMs).toISOString();
          const size = stat.size;

          let contentHash = '';
          let tokenEstimate = 0;
          if (size > 0) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              contentHash = computeHash(content);
              tokenEstimate = estimateTokenCount(content);
            } catch {
              // binary file
            }
          }

          upsert.run(fullPath, name, ext, size, modifiedAt, contentHash, tokenEstimate, kind);
          indexed++;
        } catch (err) {
          console.error(`[ERROR] Failed to index ${fullPath}: ${err.message}`);
          errors++;
        }
      }
    }

    walk(absDir);
  } finally {
    db.close();
  }

  return { scanned, indexed, skipped, errors };
}

/**
 * Searches file metadata using FTS5.
 * @param {string} query - FTS5 search term
 * @param {{ kind?: string, ext?: string, limit?: number, offset?: number, dbPath?: string }} [options]
 * @returns {Array<{path: string, name: string, ext: string, size: number, modified_at: string, kind: string, score: number}>}
 */
export function searchFiles(query, options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const kind = options.kind || null;
  const ext = options.ext || null;
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const db = openDatabase(dbPath);
  try {
    const escaped = escapeFtsQuery(query);
    const hasFtsQuery = escaped && escaped.length > 0;
    const conditions = [];
    const params = [];

    if (hasFtsQuery) {
      conditions.push('file_metadata_fts MATCH ?');
      params.push(escaped);
    }

    if (kind) {
      conditions.push('m.kind = ?');
      params.push(kind);
    }
    if (ext) {
      conditions.push('m.ext = ?');
      params.push(ext.startsWith('.') ? ext : `.${ext}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT m.path, m.name, m.ext, m.size, m.modified_at, m.kind${hasFtsQuery ? ', rank as score' : ', 0 as score'}
      FROM file_metadata m
      ${hasFtsQuery ? 'JOIN file_metadata_fts f ON m.id = f.rowid' : ''}
      ${whereClause}
      ${hasFtsQuery ? 'ORDER BY score ASC' : 'ORDER BY m.modified_at DESC'}
      LIMIT ? OFFSET ?
    `;

    try {
      return db.prepare(sql).all(...params, limit, offset);
    } catch (err) {
      // If syntax error in raw match term, try fallback
      if (!hasFtsQuery) return [];
      const fallbackEscaped = `"${query.replace(/"/g, '""')}"`;
      const fbConditions = ['file_metadata_fts MATCH ?'];
      const fbParams = [fallbackEscaped];
      if (kind) { fbConditions.push('m.kind = ?'); fbParams.push(kind); }
      if (ext) { fbConditions.push('m.ext = ?'); fbParams.push(ext); }
      fbParams.push(limit, offset);
      const fallbackSql = `
        SELECT m.path, m.name, m.ext, m.size, m.modified_at, m.kind, rank as score
        FROM file_metadata m
        JOIN file_metadata_fts f ON m.id = f.rowid
        WHERE ${fbConditions.join(' AND ')}
        ORDER BY score ASC
        LIMIT ? OFFSET ?
      `;
      return db.prepare(fallbackSql).all(...fbParams);
    }
  } finally {
    db.close();
  }
}

/**
 * Lists recently modified files.
 * @param {{ days?: number, limit?: number, dbPath?: string }} [options]
 * @returns {Array<object>}
 */
export function recentFiles(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const days = options.days || 7;
  const limit = options.limit || 50;

  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const db = openDatabase(dbPath);
  try {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return db.prepare(`
      SELECT path, name, ext, size, modified_at, kind, token_estimate
      FROM file_metadata
      WHERE modified_at >= ?
      ORDER BY modified_at DESC
      LIMIT ?
    `).all(cutoff, limit);
  } finally {
    db.close();
  }
}

/**
 * Lists files that haven't been modified recently.
 * @param {{ olderThanDays?: number, limit?: number, dbPath?: string }} [options]
 * @returns {Array<object>}
 */
export function staleFiles(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const olderThanDays = options.olderThanDays || 30;
  const limit = options.limit || 50;

  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const db = openDatabase(dbPath);
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    return db.prepare(`
      SELECT path, name, ext, size, modified_at, kind, token_estimate
      FROM file_metadata
      WHERE modified_at < ?
      ORDER BY modified_at ASC
      LIMIT ?
    `).all(cutoff, limit);
  } finally {
    db.close();
  }
}

/**
 * Gets database statistics.
 * @param {string} dbPath
 * @returns {{ total: number, by_kind: Record<string, number>, total_tokens: number, db_size: number }}
 */
export function stats(dbPath = DEFAULT_DB_PATH) {
  if (!fs.existsSync(dbPath)) {
    return { total: 0, by_kind: {}, total_tokens: 0, db_size: 0 };
  }

  const db = openDatabase(dbPath);
  try {
    const totalRow = db.prepare('SELECT COUNT(*) AS total FROM file_metadata').get();
    const kindRows = db.prepare('SELECT kind, COUNT(*) AS count FROM file_metadata GROUP BY kind ORDER BY count DESC').all();
    const tokenRow = db.prepare('SELECT COALESCE(SUM(token_estimate), 0) AS total FROM file_metadata').get();

    const by_kind = {};
    for (const row of kindRows) {
      by_kind[row.kind || 'unknown'] = row.count;
    }

    let dbSize = 0;
    try {
      dbSize = fs.statSync(dbPath).size;
    } catch { /* ignore */ }

    return {
      total: totalRow ? Number(totalRow.total) : 0,
      by_kind,
      total_tokens: tokenRow ? Number(tokenRow.total) : 0,
      db_size: dbSize
    };
  } finally {
    db.close();
  }
}

/**
 * CLI handler for file-metadata-store.
 * @param {string[]} args
 */
export function runCli(args = process.argv.slice(2)) {
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Usage: node tools/file-metadata-store.mjs <command> [options]

Commands:
  index <dir>          Index files in a directory
    --db <path>          Database path (default: ~/.claude/file-metadata/meta.sqlite)
    --glob <pattern>     Glob pattern to filter files (can repeat)
    --no-recursive       Don't recurse into subdirectories

  search <query>       Search indexed files by FTS5 query
    --db <path>          Database path
    --kind <type>        Filter by kind (code, doc, data, config, script, other)
    --ext <ext>          Filter by extension (e.g., .mjs, .md)
    --limit <n>          Max results (default: 50)
    --offset <n>         Offset (default: 0)

  recent               Show recently modified files
    --db <path>
    --days <n>           Days to look back (default: 7)
    --limit <n>          Max results (default: 50)

  stale                Show stale files
    --db <path>
    --older-than <days>  Age threshold (default: 30)
    --limit <n>          Max results (default: 50)

  stats                Show database statistics
    --db <path>
    --json               Output as JSON (default: table)

Examples:
  node file-metadata-store.mjs index ./src
  node file-metadata-store.mjs index ./docs --glob "*.md"
  node file-metadata-store.mjs search "config" --kind config
  node file-metadata-store.mjs recent --days 1
  node file-metadata-store.mjs stale --older-than 60
  node file-metadata-store.mjs stats --json
`);
    return;
  }

  const restArgs = args.slice(1);

  switch (command) {
    case 'index': {
      const { values, positionals } = parseArgs({
        args: restArgs,
        options: {
          db: { type: 'string' },
          glob: { type: 'string', multiple: true },
          'no-recursive': { type: 'boolean', default: false }
        },
        allowPositionals: true
      });
      const targetDir = positionals[0];
      if (!targetDir) {
        console.error('[ERROR] index requires a directory path');
        process.exit(1);
      }
      const result = indexDirectory(targetDir, {
        recursive: !values['no-recursive'],
        globPatterns: values.glob || undefined,
        dbPath: values.db || DEFAULT_DB_PATH
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'search': {
      const { values, positionals } = parseArgs({
        args: restArgs,
        options: {
          db: { type: 'string' },
          kind: { type: 'string' },
          ext: { type: 'string' },
          limit: { type: 'string', default: '50' },
          offset: { type: 'string', default: '0' },
          json: { type: 'boolean', default: false }
        },
        allowPositionals: true
      });
      const searchTerm = positionals[0];
      if (!searchTerm) {
        console.error('[ERROR] search requires a query term');
        process.exit(1);
      }
      const results = searchFiles(searchTerm, {
        kind: values.kind || undefined,
        ext: values.ext || undefined,
        limit: parseInt(values.limit, 10),
        offset: parseInt(values.offset, 10),
        dbPath: values.db || DEFAULT_DB_PATH
      });
      if (results.length === 0) {
        console.log('No results found.');
      } else if (values.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.table(results);
      }
      break;
    }

    case 'recent': {
      const { values } = parseArgs({
        args: restArgs,
        options: {
          db: { type: 'string' },
          days: { type: 'string', default: '7' },
          limit: { type: 'string', default: '50' },
          json: { type: 'boolean', default: false }
        },
        allowPositionals: true
      });
      const files = recentFiles({
        days: parseInt(values.days, 10),
        limit: parseInt(values.limit, 10),
        dbPath: values.db || DEFAULT_DB_PATH
      });
      if (files.length === 0) {
        console.log('No recent files found.');
      } else if (values.json) {
        console.log(JSON.stringify(files, null, 2));
      } else {
        console.table(files);
      }
      break;
    }

    case 'stale': {
      const { values } = parseArgs({
        args: restArgs,
        options: {
          db: { type: 'string' },
          'older-than': { type: 'string', default: '30' },
          limit: { type: 'string', default: '50' },
          json: { type: 'boolean', default: false }
        },
        allowPositionals: true
      });
      const files = staleFiles({
        olderThanDays: parseInt(values['older-than'], 10),
        limit: parseInt(values.limit, 10),
        dbPath: values.db || DEFAULT_DB_PATH
      });
      if (files.length === 0) {
        console.log('No stale files found.');
      } else if (values.json) {
        console.log(JSON.stringify(files, null, 2));
      } else {
        console.table(files);
      }
      break;
    }

    case 'stats': {
      const { values } = parseArgs({
        args: restArgs,
        options: {
          db: { type: 'string' },
          json: { type: 'boolean', default: false }
        },
        allowPositionals: true
      });
      const s = stats(values.db || DEFAULT_DB_PATH);
      if (values.json) {
        console.log(JSON.stringify(s, null, 2));
      } else {
        console.table(s);
      }
      break;
    }

    default: {
      console.error(`[ERROR] Unknown command: ${command}`);
      console.error('Run with --help to see available commands.');
      process.exit(1);
    }
  }
}

// Auto-run when executed as main script
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) {
  runCli();
}