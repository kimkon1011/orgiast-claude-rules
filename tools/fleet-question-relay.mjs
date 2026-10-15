#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { redactSecrets } from './fleet-agent.mjs';

// Hook budget: docs/fleet-mail-v2-design.md §5 and registered hook timeout (5s).
export const HOOK_DEADLINE_MS = 5000;
export const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
export const QUESTION_LIMIT = 2000;
export const SUMMARY_LIMIT = 600;
export const RELAY_WAIT_MS = 10 * 60 * 1000;
export const RESUME_LIMIT_MS = 30 * 60 * 1000;
export const QUESTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const FORWARDED_QUESTION_NOTICE = 'kim-PC の回答は別セッションで再開されます。この画面の質問は Esc で閉じてよい';
export const QUESTION_LOCK_MS = 30 * 1000;
export const HUB_LABEL = 'kim-PC';
export function validSessionId(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,179}$/.test(String(id ?? ''))) throw new Error('invalid session id');
  return id;
}
export function questionPath(home, id) { return path.join(home, '.claude', 'fleet-questions', `${validSessionId(id)}.json`); }
export function readQuestion(home, id) {
  try { return JSON.parse(fs.readFileSync(questionPath(home, id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// This lock covers synchronous local changes only, never network or child execution.
export function updateQuestion(home, id, update) {
  const file = questionPath(home, id), lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const reclaim = `${lock}.reclaim`;
      try { fs.mkdirSync(reclaim); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs < QUESTION_LOCK_MS) return null;
        fs.unlinkSync(lock);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { fs.rmdirSync(reclaim); }
    }
  }
  if (fd === undefined) return null;
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(fd, nonce);
    const current = readQuestion(home, id), next = update(current);
    if (!next || next === current) return next;
    fs.writeFileSync(tmp, JSON.stringify(next) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return next;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* A leftover temp never owns the question. */ }
    fs.closeSync(fd);
    try { if (fs.readFileSync(lock, 'utf8') === nonce) fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function readTranscriptTail(file, io = fs) {
  const fd = io.openSync(file, 'r');
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a transcript file');
    const size = stat.size;
    let start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const read = (at, length) => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, io.readSync(fd, buffer, 0, length, at));
    };
    let buffer = read(start, size - start);
    let completeBytes = buffer.lastIndexOf(10) + 1;
    // An unusually long unfinished line may fill the entire tail. Locate the
    // preceding complete line in bounded chunks instead of storing a mid-line offset.
    while (!completeBytes && start > 0) {
      const end = start;
      start = Math.max(0, end - TRANSCRIPT_TAIL_BYTES);
      buffer = read(start, end - start);
      completeBytes = buffer.lastIndexOf(10) + 1;
    }
    const offset = completeBytes ? start + completeBytes : 0;
    let text = buffer.subarray(0, completeBytes).toString('utf8');
    if (start) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    const records = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    return { records, size, offset };
  } finally { io.closeSync(fd); }
}
export function detectQuestion(record) {
  const content = record?.message?.content ?? record?.content;
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: typeof content === 'string' ? content : '' }];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
  const asks = blocks.filter(b => b.type === 'tool_use' && b.name === 'AskUserQuestion');
  const questions = asks.flatMap(b => Array.isArray(b.input?.questions) ? b.input.questions : []);
  const last = text.split(/\r?\n/).at(-1) || '';
  // An instruction list / quoted example / fenced or inline code is not a final question.
  const codeOrSteps = /^(?:\s*(?:[-*+] |\d+[.)] |>|\$ |```|~~~))/.test(last)
    || /^(?:const|let|var|return|if|function|import)\b/.test(last) || /[`}]\s*$/.test(last) || (text.match(/^\s*```/gm) || []).length % 2 === 1;
  if (!asks.length && (codeOrSteps || !(/[?？]$/.test(last) || /どうしますか|どちらにしますか|選んでください|確認してください|教えてください/.test(last)))) return null;
  const question = asks.length ? redactSecrets(questions.map(q => q.question || '').join('\n') || text).slice(0, QUESTION_LIMIT) : redactSecrets(text).slice(-QUESTION_LIMIT);
  if (!question) return null;
  const options = questions.map(q => ({ question: redactSecrets(q.question || '').slice(0, QUESTION_LIMIT),
    options: (Array.isArray(q.options) ? q.options : []).slice(0, 20).map(o => ({ label: redactSecrets(o.label || '').slice(0, 200), description: redactSecrets(o.description || '').slice(0, 400) })), multiSelect: !!q.multiSelect })).filter(q => q.options.length || q.multiSelect).slice(0, 10);
  return { question, options, summary: redactSecrets(text || question).slice(0, SUMMARY_LIMIT),
    questionHash: createHash('sha256').update(JSON.stringify({ question, options })).digest('hex') };
}
export async function main({ home = process.env.ORGIAST_HOME || os.homedir(), readStdin = readStdinWithTimeout, now = Date.now, env = process.env } = {}) {
  try {
    const config = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8'));
    if (!config.FLEET_HUB) return;
    const input = JSON.parse(await readStdin(500));
    if (input.stop_hook_active) return;
    validSessionId(input.session_id);
    const event = input.hook_event_name || 'Stop';
    let tail = { records: [], offset: 0 };
    try { tail = readTranscriptTail(input.transcript_path); } catch { if (event === 'Stop') return; }
    const { records, offset } = tail;
    let detected;
    if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') {
      const questions = input.tool_input?.questions || [input.tool_input || {}];
      detected = detectQuestion({ content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions } }] });
    } else if (event === 'Notification') {
      if (/needs your permission|permission to use|Claude needs your/i.test(input.message || '')) return;
      detected = detectQuestion({ content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: input.message || '' }] } }] });
    } else if (event === 'Stop') {
      const last = records.findLastIndex(r => r.type === 'assistant' || r.message?.role === 'assistant');
      if (last < 0 || records.slice(last + 1).some(isUserMessage)) return;
      detected = detectQuestion(records[last]);
    }
    if (!detected) return;
    updateQuestion(home, input.session_id, current => {
      if (current?.questionHash === detected.questionHash || current?.detectedHash === detected.questionHash) return current;
      // Notification/Stop can repeat AskUserQuestion text without its options.
      // Enrich an earlier notification without resetting its relay identity or clock.
      if (current?.question === detected.question && (!current.options?.length || !detected.options.length)) {
        return !current.options?.length && detected.options.length ? { ...current, options: detected.options, detectedHash: detected.questionHash } : current;
      }
      return { sessionId: input.session_id, cwd: input.cwd, ...detected, askedAt: new Date(now()).toISOString(),
        transcriptPath: input.transcript_path, transcriptOffset: offset,
        drivenByHub: current?.drivenByHub === true || env.FLEET_DRIVEN_BY_HUB === '1',
        relayedAt: null, resumingAt: current?.resumingAt || null, ...((env.FLEET_RESUME_MAIL_ID || current?.resumeMailId) ? { resumeMailId: env.FLEET_RESUME_MAIL_ID || current.resumeMailId } : {}) };
    });
  } catch { /* Stop must never block a user, including missing transcripts and malformed input. */ }
}
function isUserMessage(record) {
  if (record.type !== 'user' && record.message?.role !== 'user') return false;
  return true; // AskUserQuestion answers can themselves arrive as user tool_result blocks.
}
export async function hasNewUserMessage(question) {
  // Scan appended JSONL as a stream; never load the transcript into memory.
  if (!question.transcriptPath) return true;
  const stat = fs.statSync(question.transcriptPath);
  if (!stat.isFile() || stat.size < (question.transcriptOffset || 0)) return true;
  const stream = fs.createReadStream(question.transcriptPath, { start: question.transcriptOffset || 0, encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (isUserMessage(record) && (question.transcriptOffset !== undefined || !record.timestamp || Date.parse(record.timestamp) > Date.parse(question.askedAt))) return true;
    }
    return false;
  } finally { lines.close(); stream.destroy(); }
}
export function clearResume(home, sessionId, mailId) {
  return updateQuestion(home, sessionId, current => {
    if (!current || current.resumeMailId !== mailId) return current;
    const next = { ...current, drivenByHub: false };
    delete next.resumingAt; delete next.resumeMailId;
    return next;
  });
}
export function reconcileResumes({ home, now = Date.now }) {
  const dir = path.join(home, '.claude', 'fleet-questions');
  let files;
  try { files = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of files.filter(n => /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(n))) {
    try {
      const q = readQuestion(home, name.slice(0, -5));
      if (!/^mail-[A-Za-z0-9-]{1,180}$/.test(q?.resumeMailId || '')) continue;
      const finished = fs.existsSync(path.join(home, '.claude', 'fleet-agent-results', `${q.resumeMailId}.json`));
      if (finished || (q.resumingAt && now() - Date.parse(q.resumingAt) >= RESUME_LIMIT_MS)) clearResume(home, name.slice(0, -5), q.resumeMailId);
    } catch { /* A competing hook will release its short lock before the next poll. */ }
  }
}
export function collectQuestions({ home, now = Date.now }) {
  const dir = path.join(home, '.claude', 'fleet-questions');
  let files;
  try { files = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let removed = 0;
  for (const name of files.filter(n => /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(n))) {
    const file = path.join(dir, name);
    try {
      if (now() - fs.statSync(file).mtimeMs <= QUESTION_RETENTION_MS) continue;
      updateQuestion(home, name.slice(0, -5), current => {
        if (now() - fs.statSync(file).mtimeMs <= QUESTION_RETENTION_MS || (current?.resumingAt && now() - Date.parse(current.resumingAt) < RESUME_LIMIT_MS)) return current;
        fs.unlinkSync(file); removed++;
        return null;
      });
    } catch { /* Concurrent writers and malformed records are retried next poll. */ }
  }
  return removed;
}
export async function relayQuestions({ home, hub, label, request, now = Date.now, stderr = console.error }) {
  if (!hub || hub === label) return 0;
  const dir = path.join(home, '.claude', 'fleet-questions');
  let files; try { files = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let sent = 0;
  for (const name of files.filter(n => /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(n))) {
    try {
      const q = readQuestion(home, name.slice(0, -5));
      if (!q?.question || q.relayedAt || !Number.isFinite(Date.parse(q.askedAt))) continue;
      if (!q.drivenByHub && (now() - Date.parse(q.askedAt) < RELAY_WAIT_MS || await hasNewUserMessage(q))) continue;
      // A stable transport id makes a lost response/local-write retry safe.
      const id = `mail-question-${createHash('sha256').update(`${label}\n${q.sessionId}\n${q.questionHash}`).digest('hex').slice(0, 24)}`;
      const result = await request('mail-send', { id, from: label, to: hub, messageKind: 'note', priority: 'urgent', auto: false, hop: 0,
        why: `[判断依頼] ${label} のセッション質問`,
        body: redactSecrets(`[判断依頼]\nPC: ${label}\n質問: ${q.question}\n選択肢: ${JSON.stringify(q.options)}\ncwd: ${q.cwd}\nsessionId: ${q.sessionId}\n直近の作業要約: ${q.summary}`).slice(0, 20000),
        meta: { relay: { sessionId: q.sessionId, cwd: q.cwd, questionHash: q.questionHash, pcLabel: label } },
        expiresAt: new Date(now() + 72 * 3600000).toISOString() });
      if (!result?.ok) throw new Error('relay send failed');
      updateQuestion(home, q.sessionId, current => current?.questionHash === q.questionHash ? { ...current, relayedAt: new Date(now()).toISOString(), sentId: id } : current);
      sent++;
    } catch { stderr('fleet-mail: 質問転送再試行待ち=1'); }
  }
  return sent;
}
if (isEntry(import.meta.url)) await main();
