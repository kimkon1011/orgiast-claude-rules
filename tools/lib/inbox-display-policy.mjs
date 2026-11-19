import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!(pid > 0)) return null;
      try { process.kill(pid, 0); return null; }
      catch (error) { if (error.code !== 'ESRCH') return null; fs.unlinkSync(file); }
    }
  }
  return null;
}

export const FINAL_ONLY_INSTRUCTION = '【表示ルール】この一覧は途中のメッセージ・ツール呼び出しの合間には書かない。このターンの本当に最後のメッセージ（【最終まとめ】の中）にだけ1回載せる。前回から変化が無い項目は再掲しない。';
const defaultHome = () => process.env.ORGIAST_HOME || os.homedir();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function read(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return object(value) ? value : {}; }
  catch { return {}; }
}
function update(home, name, fn) {
  let release, tmp;
  try {
    const file = path.join(home, '.claude', name + '.json');
    release = acquireLock(file + '.lock');
    if (!release) return null;
    const state = read(file);
    const result = fn(state);
    tmp = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return result;
  } catch { return null; }
  finally { try { if (tmp) fs.rmSync(tmp, { force: true }); } catch {} try { release?.(); } catch {} }
}
export function selectNew({ home = defaultHome(), hook, sessionId, ids = [], now = Date.now() } = {}) {
  now = typeof now === 'function' ? now() : now;
  const fallback = { fresh: [...ids], known: 0, knownFromOtherSessions: 0 };
  if (!hook || !sessionId || !ids.length) return fallback;
  return update(home, 'inbox-display-shown', state => {
    for (const entries of Object.values(state)) {
      if (!object(entries)) continue;
      for (const [id, entry] of Object.entries(entries)) {
        if (!object(entry) || now - entry.firstShownAt > 30 * 86400_000) delete entries[id];
      }
    }
    if (!object(state[hook])) state[hook] = {};
    const entries = state[hook], fresh = [];
    let known = 0, knownFromOtherSessions = 0;
    for (const id of new Set(ids)) {
      const entry = entries[id];
      const sessions = object(entry?.sessions) ? entry.sessions : {};
      if (Object.hasOwn(sessions, sessionId)) { known++; continue; }
      if (Object.values(sessions).some(at => now - at <= 86400_000)) {
        known++;
        knownFromOtherSessions++;
        continue;
      }
      fresh.push(id);
      entries[id] = { firstShownAt: now, sessions: { ...sessions, [sessionId]: now } };
    }
    return { fresh, known, knownFromOtherSessions };
  }) ?? fallback;
}
// Compatibility for callers that previously recorded after selection; selection is now atomic.
export function markShown(options) { selectNew(options); }
const hash = prompt => createHash('sha256').update(prompt).digest('hex');
export function isLoopWake(input = {}, { home = defaultHome(), now = Date.now(), hook = 'default' } = {}) {
  now = typeof now === 'function' ? now() : now;
  const prompt = String(input.prompt || '');
  const explicit = prompt.includes('<<autonomous-loop') || prompt.startsWith('/loop');
  const session = String(input.session_id || input.sessionId || '');
  if (!session || !prompt) return explicit;
  // Each hook observes the same submission independently; one hook must not silence the others.
  return update(home, 'inbox-display-last-prompt', state => {
    const previous = state[session]?.consumers?.[hook] ?? (hook === 'default' ? state[session] : null);
    const repeated = previous?.hash === hash(prompt) && now - previous.at <= 6 * 3600_000;
    const consumers = state[session]?.consumers || {};
    consumers[hook] = { hash: hash(prompt), at: now };
    state[session] = { hash: hash(prompt), at: now, consumers };
    return explicit || repeated;
  }) ?? explicit;
}
export function recordPrompt(input, options) { isLoopWake(input, options); }
