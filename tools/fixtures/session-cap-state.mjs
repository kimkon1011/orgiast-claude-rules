import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function db(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  try {
    conn.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    conn.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run('Anthropic.claude-code', JSON.stringify(state));
  } finally { conn.close(); }
}
