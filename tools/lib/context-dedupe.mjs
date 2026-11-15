import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(String(value)).digest('hex');

// Each source/block has its own last emitted hash: unrelated hooks and empty
// polls must not reset it. Hash filenames keep session IDs out of filesystem paths.
export function dedupeContext(text, { sessionId, source, home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  if (!text || !sessionId || !source) return text;
  const file = path.join(home, '.claude', 'state', 'context-dedupe', hash(sessionId), `${hash(source)}.json`);
  const digest = hash(text);
  let fd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Serialize source hooks that can run in different worker threads/processes.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fd = fs.openSync(`${file}.lock`, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    if (fd === undefined) return text; // State failure must not hide new context.
    let prior;
    try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (prior?.hash === digest) return '';
    fs.writeFileSync(file, JSON.stringify({ hash: digest }), { mode: 0o600 });
    return text;
  } catch { return text; }
  finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      try { fs.unlinkSync(`${file}.lock`); } catch {}
    }
  }
}
