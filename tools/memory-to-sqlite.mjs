import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

/**
 * Parses markdown frontmatter and body.
 * Expects content starting with --- and delimited by ---.
 * @param {string} content
 * @returns {{ name: string, type: string, description: string, body: string }}
 */
export function parseFrontmatter(content) {
  if (typeof content !== 'string') {
    throw new Error('Content must be a string');
  }

  const normalized = content.replace(/^\uFEFF/, '').trimStart();
  if (!normalized.startsWith('---')) {
    throw new Error('Invalid frontmatter: content must start with ---');
  }

  const parts = normalized.split(/^---$/m);
  if (parts.length < 3) {
    throw new Error('Invalid frontmatter: missing closing --- delimiter');
  }

  const yamlPart = parts[1];
  const bodyPart = parts.slice(2).join('---').trim();

  const meta = {};
  for (const line of yamlPart.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      let val = trimmed.slice(colonIdx + 1).trim();

      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }

  return {
    name: meta.name || '',
    type: meta.type || 'general',
    description: meta.description || '',
    body: bodyPart
  };
}

/**
 * Initializes SQLite database and sets up memories and FTS5 tables/triggers.
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
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      type TEXT,
      description TEXT,
      body TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      name,
      body,
      content='memories',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, name, body) VALUES (new.id, new.name, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, body) VALUES('delete', old.id, old.name, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, body) VALUES('delete', old.id, old.name, old.body);
      INSERT INTO memories_fts(rowid, name, body) VALUES (new.id, new.name, new.body);
    END;
  `);

  return db;
}

/**
 * Imports markdown memory files from dirPath into the SQLite database.
 * @param {string} dirPath
 * @param {{ dbPath?: string }} [options]
 * @returns {{ scanned: number, imported: number, skipped: number, errors: number }}
 */
export function importMemoryDirectory(dirPath, options = {}) {
  const dbPath = options.dbPath || path.join(dirPath, 'memory.sqlite');

  let scanned = 0;
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  if (!fs.existsSync(dirPath)) {
    console.error(`[ERROR] Directory does not exist: ${dirPath}`);
    return { scanned: 0, imported: 0, skipped: 0, errors: 1 };
  }

  const db = openDatabase(dbPath);

  const upsertStmt = db.prepare(`
    INSERT INTO memories (name, type, description, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      type = excluded.type,
      description = excluded.description,
      body = excluded.body,
      updated_at = excluded.updated_at
  `);

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fileName = entry.name;
      if (!fileName.toLowerCase().endsWith('.md')) continue;

      scanned++;

      if (fileName.toUpperCase() === 'MEMORY.MD') {
        console.error(`[INFO] Skipping index file: ${fileName}`);
        skipped++;
        continue;
      }

      const filePath = path.join(dirPath, fileName);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = parseFrontmatter(content);

        if (!parsed.name || parsed.name === 'index') {
          console.error(`[INFO] Skipping file with missing or index name (${parsed.name}): ${fileName}`);
          skipped++;
          continue;
        }

        const now = new Date().toISOString();
        upsertStmt.run(parsed.name, parsed.type, parsed.description, parsed.body, now, now);
        imported++;
        console.error(`[INFO] Imported: ${parsed.name} from ${fileName}`);
      } catch (err) {
        console.error(`[ERROR] Failed to process ${fileName}: ${err.message}`);
        errors++;
      }
    }
  } finally {
    db.close();
  }

  return { scanned, imported, skipped, errors };
}

/**
 * Searches memories in SQLite using FTS5.
 * @param {string} dbPath
 * @param {string} searchTerm
 * @returns {Array<object>}
 */
export function queryMemories(dbPath, searchTerm) {
  if (!fs.existsSync(dbPath)) {
    console.error(`[WARN] Database file not found: ${dbPath}`);
    return [];
  }

  const db = openDatabase(dbPath);
  try {
    const query = `
      SELECT m.id, m.name, m.type, m.description, m.body, m.created_at, m.updated_at
      FROM memories m
      JOIN memories_fts f ON m.id = f.rowid
      WHERE memories_fts MATCH ?
      ORDER BY m.id ASC
    `;
    return db.prepare(query).all(searchTerm);
  } catch (err) {
    console.error(`[ERROR] FTS search failed for term "${searchTerm}": ${err.message}`);
    // If syntax error in raw match term, try escaping term as phrase
    try {
      const escaped = `"${searchTerm.replace(/"/g, '""')}"`;
      const query = `
        SELECT m.id, m.name, m.type, m.description, m.body, m.created_at, m.updated_at
        FROM memories m
        JOIN memories_fts f ON m.id = f.rowid
        WHERE memories_fts MATCH ?
        ORDER BY m.id ASC
      `;
      return db.prepare(query).all(escaped);
    } catch {
      return [];
    }
  } finally {
    db.close();
  }
}

/**
 * Lists all memory records in the database.
 * @param {string} dbPath
 * @returns {Array<{ name: string, type: string, description: string }>}
 */
export function listMemories(dbPath) {
  if (!fs.existsSync(dbPath)) {
    console.error(`[WARN] Database file not found: ${dbPath}`);
    return [];
  }

  const db = openDatabase(dbPath);
  try {
    return db.prepare('SELECT name, type, description FROM memories ORDER BY name ASC').all();
  } finally {
    db.close();
  }
}

/**
 * Gets memory statistics from the database.
 * @param {string} dbPath
 * @returns {{ total: number, by_type: Record<string, number> }}
 */
export function getStats(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { total: 0, by_type: {} };
  }

  const db = openDatabase(dbPath);
  try {
    const totalRow = db.prepare('SELECT COUNT(*) AS total FROM memories').get();
    const typeRows = db.prepare('SELECT type, COUNT(*) AS count FROM memories GROUP BY type ORDER BY count DESC').all();

    const by_type = {};
    for (const row of typeRows) {
      by_type[row.type || 'unknown'] = row.count;
    }

    return {
      total: totalRow ? Number(totalRow.total) : 0,
      by_type
    };
  } finally {
    db.close();
  }
}

/**
 * Main CLI handler
 */
export function runCli(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string', default: 'memory' },
      query: { type: 'string' },
      list: { type: 'boolean', default: false },
      stats: { type: 'boolean', default: false }
    },
    allowPositionals: true
  });

  const memoryDir = values.dir;
  const dbPath = path.join(memoryDir, 'memory.sqlite');

  if (values.query !== undefined) {
    const results = queryMemories(dbPath, values.query);
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (values.list) {
    const items = listMemories(dbPath);
    if (items.length === 0) {
      console.log('No memory records found.');
    } else {
      console.table(items);
    }
    return;
  }

  if (values.stats) {
    const stats = getStats(dbPath);
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  // Default mode: import files from memory directory
  const result = importMemoryDirectory(memoryDir, { dbPath });
  console.log(JSON.stringify(result, null, 2));
}

// Auto-run when executed as main script
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) {
  runCli();
}
