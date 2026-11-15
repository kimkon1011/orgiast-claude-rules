import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealText } from './knowledge-envelope.mjs';
import { openKnowledge } from '../knowledge-lock.mjs';

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function handoffLockEnabled(deps = {}) {
  return fs.existsSync(path.join(deps.toolsDir || toolsDir, 'knowledge-lock-pubkey.pem'));
}

export function writeHandoff(file, text, deps = {}) {
  fs.writeFileSync(file, text, 'utf8');
  if (!handoffLockEnabled(deps)) return;
  try {
    const dir = deps.toolsDir || toolsDir;
    const meta = path.join(dir, 'knowledge-lock-pubkey.json');
    const sealed = (deps.sealText || sealText)(text, { name: path.basename(file),
      publicKeyPem: fs.readFileSync(path.join(dir, 'knowledge-lock-pubkey.pem'), 'utf8'),
      kid: fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')).kid : 'k1',
      now: (deps.now || Date.now)() });
    fs.writeFileSync(file + '.lock', sealed, { mode: 0o600 });
  } catch {
    try {
      const log = path.join(deps.home || os.homedir(), '.claude/logs/knowledge-lock.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(log, new Date().toISOString() + ' handoff seal failed; plaintext saved\n', { mode: 0o600 });
    } catch { /* Logging must not undo a successful plaintext write. */ }
  }
}

export async function readHandoff(file, deps = {}) {
  try { return await (deps.readFile || fs.promises.readFile)(file, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT' || !handoffLockEnabled(deps) || !fs.existsSync(file + '.lock')) throw error;
  }
  return openKnowledge(file + '.lock', { ...deps, timeoutMs: 8000 });
}
