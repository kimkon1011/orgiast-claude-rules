import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function directory() {
  return process.env.CHANGE_GATE_DIR || path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'change-gate');
}

function safeJob(job) {
  const value = String(job || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`invalid change-gate job: ${value}`);
  return value;
}

function cursorFile(job) { return path.join(directory(), `${safeJob(job)}.cursor.json`); }

export function loadCursor(job) {
  try { return JSON.parse(fs.readFileSync(cursorFile(job), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function saveCursor(job, cursor) {
  const file = cursorFile(job);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cursor, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0, 16);
}

export function gate(job, input = {}) {
  const items = Array.isArray(input.items) ? input.items : null;
  if (items && items.length === 0) return { changed: false, reason: 'empty' };
  const previous = loadCursor(job);
  if (input.fingerprint && previous?.fingerprint === input.fingerprint) return { changed: false, reason: 'same-fingerprint' };
  return { changed: true, reason: previous ? 'changed' : 'first-run' };
}

export function commit(job, { fingerprint: value, cursor } = {}) {
  saveCursor(job, { fingerprint: value || null, cursor: cursor ?? null, committedAt: new Date().toISOString() });
}

export function recordRun(job, { changed, llmInvoked, items = 0, note = '' } = {}) {
  try {
    const dir = directory();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'runs.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), host: os.hostname(), job: safeJob(job), changed: Boolean(changed), llmInvoked: Boolean(llmInvoked), items: Number(items) || 0, note: String(note || '') })}\n`, 'utf8');
  } catch (error) { console.error(`[change-gate] recordRun failed: ${error.message}`); }
}
