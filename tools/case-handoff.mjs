#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { keyserveAuthHeaders, keyserveSecret, requireKeyservePcId } from './keyserve-auth.mjs';
import { claudeAccount, isKimOperated } from './lib/kim-operated.mjs';
import { CASE_ID, detectCases, nextBatch, resumeText, hash, validateIdentity } from './lib/case-handoff.mjs';

const script = fileURLToPath(import.meta.url);
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function updateBinding(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`, until = Date.now() + 2000;
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner; try { owner = Number(fs.readFileSync(lock, 'utf8')); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); } catch (e) { if (e.code === 'ESRCH') { fs.rmSync(lock, { force: true }); continue; } }
      }
      if (Date.now() >= until) throw Error('案件の紐付け更新が使用中です。キューを保持して再試行してください');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { const next = fn(readJson(file)); atomic(file, next); return next; }
  finally { fs.rmSync(lock, { force: true }); }
}
export function client(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const base = path.join(home, '.claude');
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = options.random || Math.random;
  const api = options.api || process.env.ORGIAST_CASE_URL || 'https://orgiast-memoryserve.vercel.app/api/case-log';
  const account = options.account || claudeAccount(home);
  const pc = options.pc || requireKeyservePcId(home);
  const bindingFile = session => { validateIdentity({ sessionId: session, pc, account }); return path.join(base, 'case-binding', `${session}.json`); };
  async function request(query, body) {
    if (!isKimOperated(home, account)) throw Error('case-handoff: kim 操作アカウントのみ利用できます');
    const url = new URL(api); for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { ...keyserveAuthHeaders(keyserveSecret(home), Date.now(), pc), 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        let data; try { data = await response.json(); } catch {}
        // Only known codes may reach hooks/logs; never echo an upstream body.
        const code = ['batch_changed', 'drive_busy', 'drive_contention', 'state_not_ready'].includes(data?.code) ? data.code : '';
        if (response.status === 409 && ['drive_busy', 'drive_contention'].includes(code) && attempt < 3) {
          await sleep(500 * 2 ** attempt + Math.floor(random() * 500)); continue;
        }
        throw Object.assign(Error(`case-handoff: HTTP ${response.status}${code ? ` [${code}]` : ''}（未送信分はキューに保持）`), { status: response.status, code });
      }
      return response.json();
    }
  }
  async function catalog(refresh = false) {
    const file = path.join(base, 'case-catalog.json');
    let saved = readJson(file, { cases: [] });
    if (refresh || Date.now() - (saved.at || 0) > 24 * 3600000) {
      saved = { ...(await request({ mode: 'catalog' })), at: Date.now() }; atomic(file, saved);
    }
    return saved.cases;
  }
  function bind(sessionId, ids, transcriptPath) {
    const file = bindingFile(sessionId);
    for (const id of ids) if (!CASE_ID.test(id)) throw Error('invalid case ID');
    return updateBinding(file, saved => {
      const old = saved || { sessionId, account, pc, cases: [], cursors: {} };
      return { ...old, cases: [...new Set([...old.cases, ...ids])], ...(transcriptPath ? { transcriptPath } : {}) };
    });
  }
  function findTranscript(sessionId) {
    const walk = dir => {
      if (!fs.existsSync(dir)) return null;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) { const result = walk(path.join(dir, ent.name)); if (result) return result; }
        else if (ent.name === `${sessionId}.jsonl`) return path.join(dir, ent.name);
      }
      return null;
    };
    return walk(path.join(base, 'projects'));
  }
  function stage(sessionId) {
    const file = bindingFile(sessionId), queued = [];
    if (!readJson(file)?.cases?.length) return queued;
    updateBinding(file, binding => {
      const transcriptPath = binding.transcriptPath || findTranscript(sessionId);
      if (!transcriptPath) throw Error('紐付いたセッションの transcript が見つかりません');
      const raw = fs.readFileSync(transcriptPath, 'utf8');
      for (const caseId of binding.cases) {
        const queueFile = path.join(base, 'case-queue', `${caseId}-${sessionId}.json`);
        if (fs.existsSync(queueFile)) { queued.push(queueFile); continue; }
        const batch = nextBatch(raw, binding.cursors[caseId], { sessionId, account: binding.account, pc: binding.pc }, caseId);
        if (batch) { atomic(queueFile, batch); queued.push(queueFile); }
      }
      return binding;
    });
    return queued;
  }
  async function drain({ dueOnly = false } = {}) {
    const dir = path.join(base, 'case-queue'); fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'worker.lock');
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      try { process.kill(pid, 0); return { busy: true }; }
      catch (err) { if (err.code !== 'ESRCH') return { busy: true }; fs.unlinkSync(lock); return drain({ dueOnly }); }
    }
    let sent = 0;
    try {
      const deadline = Date.now() + 240000;
      const eligibleSessions = new Set();
      const failed = new Set(), errors = [];
      while (Date.now() < deadline) {
        const files = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
        if (!files.length) break;
        let progressed = false;
        for (const name of files) {
          if (Date.now() >= deadline) break;
          if (failed.has(name)) continue;
          try {
            const file = path.join(dir, name), batch = readJson(file);
            const current = readJson(bindingFile(batch.sessionId));
            if (dueOnly && !eligibleSessions.has(batch.sessionId) && !fs.existsSync(path.join(base, 'case-last-error.txt')) && Date.now() - (current?.lastSentAt || 0) < 600000) continue;
            eligibleSessions.add(batch.sessionId);
            const result = await request({}, batch);
            if (result.batchId !== batch.batchId || result.stateReady !== true) throw Error('保存／STATE更新の読み戻し確認に失敗');
            updateBinding(bindingFile(batch.sessionId), binding => {
              if (!binding) throw Error('案件の紐付けが消失しました。キューを保持します');
              binding.cursors[batch.caseId] = batch.lastUuid; binding.lastSentAt = Date.now(); return binding;
            });
            fs.unlinkSync(file); sent++; progressed = true;
            stage(batch.sessionId);
          } catch (error) { failed.add(name); errors.push(error); }
        }
        if (!progressed) break;
      }
      const remaining = fs.readdirSync(dir).filter(n => n.endsWith('.json')).length;
      if (errors.length) throw Error(errors.map(error => error.message).join('; '));
      if (!remaining) fs.rmSync(path.join(base, 'case-last-error.txt'), { force: true });
      return { sent, remaining };
    } catch (e) {
      atomic(path.join(base, 'case-last-error.txt'), `${new Date().toISOString()} ${e.message}\n次回hookまたは case-handoff.mjs retry で再送します。\n`);
      throw e;
    } finally { fs.rmSync(lock, { force: true }); }
  }
  async function resume(caseId, { transcripts = false } = {}) {
    if (!CASE_ID.test(caseId)) throw Error('invalid case ID');
    const data = await request({ caseId, mode: 'resume' });
    const dir = path.join(base, 'case-sessions', caseId);
    atomic(path.join(dir, 'STATE.md'), data.state); atomic(path.join(dir, 'LOG.md'), data.log);
    if (transcripts) {
      let page = '';
      do {
        const listing = await request({ caseId, mode: 'transcripts', page });
        for (const file of listing.files) {
          if (!/^[A-Za-z0-9@._-]+\.md$/.test(file.name)) throw Error('unsafe transcript filename');
          const body = await request({ caseId, mode: 'transcript', file: file.name });
          if (hash(body.markdown) !== body.sha256) throw Error('transcript hash mismatch');
          atomic(path.join(dir, 'transcripts', file.name), body.markdown);
        }
        page = listing.nextPage || '';
      } while (page);
    }
    return resumeText(data.state, data.log);
  }
  return { home, base, account, pc, request, catalog, bind, stage, drain, resume, bindingFile };
}

function background(c, force = false) {
  fs.mkdirSync(c.base, { recursive: true });
  // One bounded queue flush must outlive SessionEnd, including Windows jobs.
  // Errors are persisted by drain(), then surfaced by the next prompt hook.
  const child = spawn(process.execPath, [script, 'retry', ...(force ? [] : ['--due'])], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ORGIAST_HOME: c.home } });
  child.on('error', e => atomic(path.join(c.base, 'case-last-error.txt'), e.message));
  child.unref();
}
export async function main(args = process.argv.slice(2)) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  if (!isKimOperated(home)) return;
  const c = client({ home });
  const [command, value] = args;
  const opt = key => args[args.indexOf(key) + 1];
  if (command === 'retry') { console.log(JSON.stringify(await c.drain({ dueOnly: args.includes('--due') }))); return; }
  if (command === 'hook') {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const session = input.session_id;
    if (!session) return;
    if (['Stop', 'SessionEnd'].includes(input.hook_event_name)) {
      c.stage(session);
      const binding = readJson(c.bindingFile(session));
      if (input.hook_event_name === 'SessionEnd' || Date.now() - (binding?.lastSentAt || 0) >= 600000) background(c, input.hook_event_name === 'SessionEnd');
      return;
    }
    const saved = readJson(path.join(c.base, 'case-catalog.json'), { cases: [] });
    const ids = detectCases(input.prompt || input.cwd || '', saved.cases);
    const binding = c.bind(session, ids, input.transcript_path);
    if (fs.existsSync(path.join(c.base, 'case-last-error.txt'))) console.log('[case-handoff] 前回の保存に失敗。キューを再送します。');
    // Retry on the next interactive event, including sessions with no case IDs.
    if (fs.existsSync(path.join(c.base, 'case-queue'))) background(c);
    for (const caseId of binding.cases) {
      const meta = await c.request({}, { op: 'touch', caseId, sessionId: session, account: c.account, pc: c.pc });
      if (meta.hasState) console.log(`[case] /case-resume ${caseId} で続きから読める${meta.warning ? `。${meta.warning}` : ''}`);
      else if (meta.warning) console.log(`[case] ${caseId}: ${meta.warning}`);
    }
    // Catalog refresh is useful even before a session has been bound by name.
    if (Date.now() - (saved.at || 0) > 24 * 3600000) {
      const fresh = await c.catalog();
      const extra = detectCases(input.prompt || '', fresh).filter(id => !binding.cases.includes(id));
      if (extra.length) {
        c.bind(session, extra, input.transcript_path);
        for (const caseId of extra) {
          const meta = await c.request({}, { op: 'touch', caseId, sessionId: session, account: c.account, pc: c.pc });
          if (meta.hasState) console.log(`[case] /case-resume ${caseId} で続きから読める${meta.warning ? `。${meta.warning}` : ''}`);
        }
      }
    }
    return;
  }
  if (command === 'flush') {
    const session = value || process.env.CLAUDE_SESSION_ID; c.stage(session);
    const result = await c.drain();
    if (result.busy || result.remaining) throw Error('更新処理中／キュー残あり。完了確認してから閉じてください');
    console.log('case-handoff: 全文保存と STATE 更新を確認しました'); return;
  }
  const ids = CASE_ID.test(value || '') ? [value] : detectCases(value, await c.catalog());
  if (ids.length !== 1) throw Error('案件を一意に特定できません。案件一覧の案件IDを指定してください');
  if (command === 'bind') {
    const session = args.includes('--session') ? opt('--session') : process.env.CLAUDE_SESSION_ID;
    if (!session) throw Error('--session <現在のセッションID> が必要です');
    c.bind(session, ids, args.includes('--transcript') ? opt('--transcript') : undefined);
    console.log(`case-handoff: ${ids[0]} に紐付けました`);
  } else if (command === 'resume' || command === 'sync') console.log(await c.resume(ids[0], { transcripts: command === 'sync' }));
  else throw Error('usage: case-handoff.mjs bind|resume|sync <案件ID/案件名> | flush <sessionId> | retry | hook');
}
if (isEntry(import.meta.url)) main().catch(e => { console.error(`[case-handoff] ${e.message}`); process.exitCode = 1; });
