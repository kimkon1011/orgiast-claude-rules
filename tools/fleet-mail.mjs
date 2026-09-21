#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { machineIdentity } from './machine-identity.mjs';
import { loadOptin, redactSecrets, targetMatches, runPrompt, consentCommand } from './fleet-agent.mjs';

const ownRepo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const LOCK_MS = 10 * 60 * 1000;
export function validId(id) {
  if (!/^mail-[A-Za-z0-9-]{1,180}$/.test(String(id ?? ''))) throw new Error('invalid mail id');
  return id;
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function envFile(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export function readInbox(home, { unreadOnly = true } = {}) {
  const dir = path.join(home, '.claude', 'fleet-inbox');
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.filter(f => /^mail-[A-Za-z0-9-]+\.json$/.test(f)).flatMap(f => {
    try {
      const mail = readJson(path.join(dir, f));
      return mail && (!unreadOnly || !mail.readAt) ? [mail] : [];
    } catch { return []; } // One damaged file must not hide other unread messages.
  }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
export function acquireLock(file, { now = Date.now, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = { pid, nonce: randomUUID(), createdAt: now() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(owner)); fs.closeSync(fd);
      const owns = () => { try { return readJson(file)?.nonce === owner.nonce; } catch { return false; } };
      const heartbeat = setInterval(() => { if (owns()) { const d = new Date(now()); fs.utimesSync(file, d, d); } }, 30_000);
      heartbeat.unref();
      return () => { clearInterval(heartbeat); if (owns()) fs.unlinkSync(file); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const reclaim = `${file}.reclaim`;
      try { fs.mkdirSync(reclaim); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
      try {
        const stat = fs.statSync(file);
        if (now() - stat.mtimeMs < LOCK_MS) return null;
        fs.unlinkSync(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { fs.rmdirSync(reclaim); }
    }
  }
  return null;
}
export function parseArgs(argv) {
  const options = {};
  const flags = new Set(['--send', '--poll', '--dry-run', '--json', '--inbox']);
  const values = new Set(['--to', '--kind', '--body-file', '--why', '--expires-hours', '--wait', '--reply', '--ack']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (Object.hasOwn(options, key)) throw new Error(`duplicate option: ${key}`);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
    else throw new Error(`unknown option or missing value: ${key}; 本文は --body-file を使ってください`);
  }
  const actions = ['--send', '--poll', '--inbox', '--reply', '--ack'].filter(k => options[k]);
  if (actions.length !== 1) throw new Error('指定は --send / --poll / --reply / --inbox / --ack のいずれか1つ');
  const allowed = {
    '--send': ['--to', '--kind', '--body-file', '--why', '--expires-hours', '--wait'],
    '--poll': ['--dry-run', '--json'], '--inbox': ['--json'], '--reply': ['--body-file'], '--ack': []
  };
  for (const key of Object.keys(options)) if (key !== actions[0] && !allowed[actions[0]].includes(key)) throw new Error(`option not applicable: ${key}`);
  if (options['--send']) {
    for (const key of ['--to', '--kind', '--body-file', '--why']) if (!options[key]?.trim()) throw new Error(`${key} 必須`);
    if (!['prompt', 'note'].includes(options['--kind'])) throw new Error('--kind must be prompt or note');
    if (options['--to'].length > 128 || options['--why'].length > 1000) throw new Error('宛先または理由が長すぎます');
  }
  if (options['--reply'] && !options['--body-file']) throw new Error('--body-file 必須');
  for (const key of ['--reply', '--ack']) if (options[key]) validId(options[key]);
  for (const key of ['--expires-hours', '--wait']) if (options[key] !== undefined && (!Number.isFinite(Number(options[key])) || Number(options[key]) < (key === '--wait' ? 0 : 0.001))) throw new Error(`invalid ${key}`);
  return options;
}
export function createClient({ url, token, fetchImpl = fetch }) {
  return async (kind, payload, timeoutMs = 60_000) => {
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ ...payload, kind, token }), signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
    });
    if (!response.ok) throw new Error(`fleet-mail HTTP ${response.status}`);
    const result = await response.json();
    if (result?.ok !== true) throw new Error(`fleet-mail: ${result?.error || 'invalid response'}`);
    // Old GAS falls back to status writes for unknown kinds: never call that a success.
    if (kind === 'mail-poll' ? !Array.isArray(result.messages) : !Object.hasOwn(result, 'mail')) throw new Error('fleet-mail: GAS mail handlers are not deployed');
    return result;
  };
}
export async function waitForReply(id, seconds, { request, now = Date.now, sleepImpl = sleep }) {
  const deadline = now() + seconds * 1000;
  while (now() < deadline) {
    try {
      const result = await request('mail-get', { id }, Math.min(60_000, deadline - now()));
      if (result.mail?.status === 'done') return { exitCode: 0, text: redactSecrets(result.mail.resultBody) };
    } catch (error) { if (now() < deadline) throw error; }
    if (now() < deadline) await sleepImpl(Math.min(15_000, deadline - now()));
  }
  return { exitCode: 2, text: `未返信（id=${id}）` };
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const dir = path.join(home, '.claude');
  const out = deps.stdout ?? (text => console.log(text));
  const err = deps.stderr ?? (text => console.error(text));
  const now = deps.now ?? Date.now;
  const inboxFile = id => path.join(dir, 'fleet-inbox', `${validId(id)}.json`);
  const log = (name, value) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `fleet-mail-${name}.jsonl`), `${JSON.stringify({ at: new Date(now()).toISOString(), ...value })}\n`, { mode: 0o600 });
  };
  if (options['--inbox']) {
    const mails = readInbox(home);
    out(options['--json'] ? JSON.stringify(mails) : mails.map(m => `${m.id} / from=${m.from} / ${m.kind} / ${m.why}\n${m.body}`).join('\n'));
    return 0;
  }
  if (options['--ack']) {
    const file = inboxFile(options['--ack']);
    const mail = readJson(file);
    if (!mail) throw new Error('inbox に該当メッセージがありません');
    writeJson(file, { ...mail, readAt: new Date(now()).toISOString() }); out(`既読: ${mail.id}`); return 0;
  }
  const config = envFile(path.join(dir, 'fleet-sheet.env'));
  if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) { err('fleet-mail: fleet-sheet.env 未設定のためスキップ'); return 0; }
  const identity = deps.identity ?? machineIdentity();
  const label = envFile(path.join(dir, 'cost-reporter.env')).REPORTER_LABEL || identity.hostname;
  const request = deps.request ?? createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl: deps.fetch });
  if (options['--send']) {
    const id = `mail-${new Date(now()).toISOString().replace(/[-:.TZ]/g, '')}-${(deps.randomInt ?? randomInt)(1000, 10000)}`;
    const payload = { id, from: label, to: options['--to'], messageKind: options['--kind'],
      body: redactSecrets(fs.readFileSync(options['--body-file'], 'utf8')).slice(0, 20000), why: redactSecrets(options['--why']),
      expiresAt: new Date(now() + Number(options['--expires-hours'] ?? 24) * 3600000).toISOString() };
    // Record the id BEFORE transport; uncertain delivery can be inspected without resending a new id.
    log('sent', { action: 'send-attempt', ...payload });
    await request('mail-send', payload); log('sent', { action: 'sent', id, to: payload.to });
    if (options['--wait'] !== undefined) {
      err(`送信済み: ${id}`);
      const result = await waitForReply(id, Number(options['--wait']), { request, now, sleepImpl: deps.sleep });
      out(result.text); return result.exitCode;
    }
    out(`送信済み: ${id}`); return 0;
  }
  if (options['--reply']) {
    const id = options['--reply'];
    await request('mail-reply', { id, from: label, resultBody: redactSecrets(fs.readFileSync(options['--body-file'], 'utf8')).slice(0, 20000) });
    log('sent', { action: 'reply', id }); out(`返信済み: ${id}`); return 0;
  }
  const dryRun = !!options['--dry-run'];
  const release = dryRun ? () => {} : acquireLock(path.join(dir, 'fleet-mail.lock'), { now });
  if (!release) { err('fleet-mail: 別の受信処理が実行中'); return 0; }
  try {
    const processedFile = path.join(dir, '.fleet-mail-processed');
    let processed = new Set();
    try { processed = new Set(fs.readFileSync(processedFile, 'utf8').split(/\r?\n/).filter(Boolean)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Reuse a poll request id until the full response is durable on disk.
    const pollFile = path.join(dir, '.fleet-mail-poll.json');
    const batch = dryRun ? {} : readJson(pollFile) || { requestId: randomUUID() };
    if (!dryRun) writeJson(pollFile, batch);
    const response = await request('mail-poll', { to: label, hostname: identity.hostname, dryRun, requestId: batch.requestId,
      processedIds: readInbox(home, { unreadOnly: false }).filter(m => m.to === 'all' && processed.has(m.id) && Date.parse(m.expiresAt) > now()).map(m => m.id) });
    if (dryRun) { out(JSON.stringify(response.messages.map(m => ({ ...m, from: redactSecrets(m.from), why: redactSecrets(m.why), body: redactSecrets(m.body), resultBody: redactSecrets(m.resultBody) })))); return 0; }
    const received = [];
    // Persist the whole batch before any potentially slow prompt execution.
    for (const raw of response.messages) {
      validId(raw.id);
      if (!targetMatches(raw.to, label, identity.hostname) || !['note', 'prompt'].includes(raw.kind)) throw new Error('invalid incoming mail');
      if (processed.has(raw.id)) continue;
      const file = inboxFile(raw.id);
      if (!fs.existsSync(file)) {
        const mail = { ...raw, from: redactSecrets(raw.from), why: redactSecrets(raw.why), body: redactSecrets(raw.body), readAt: null, receivedAt: new Date(now()).toISOString() };
        writeJson(file, mail); log('received', { id: mail.id, from: mail.from, kind: mail.kind });
      }
      received.push(raw.id);
    }
    fs.unlinkSync(pollFile);
    // Resume pending inbox records after failures, including a failed reply POST.
    const pending = readInbox(home, { unreadOnly: false }).filter(m => !processed.has(m.id));
    let promptHandled = false;
    const handled = [];
    for (const mail of pending) {
      if (mail.kind === 'prompt') {
        // Keep each poll short enough for the next two-minute delivery tick.
        if (promptHandled) continue;
        promptHandled = true;
        const resultFile = path.join(dir, 'fleet-agent-results', `${validId(mail.id)}.json`);
        let result = readJson(resultFile);
        if (!result) {
          if (mail.executionStartedAt) result = { exitCode: null, outputTail: '前回の実行が中断されました。二重実行防止のため自動再実行しません。' };
          else if (Date.parse(mail.expiresAt) <= now()) result = { exitCode: null, outputTail: '有効期限切れのため実行しません。' };
          else if (!loadOptin(path.join(dir, 'fleet-agent-optin.json')).includes('prompt')) result = { exitCode: null, outputTail: `未オプトイン。承諾コマンド: ${consentCommand('prompt')}` };
          else {
            writeJson(inboxFile(mail.id), { ...readJson(inboxFile(mail.id)), executionStartedAt: new Date(now()).toISOString() });
            const header = `これは ${mail.from} PC の Claude Code からのメッセージです。回答は標準出力に書けば自動で相手に返ります。ファイル変更や外部送信が要る内容は実行せず、必要な理由と手順を回答に書いてください。`;
            try {
              result = await runPrompt({ claudeExe: process.env.CLAUDE_CLI_PATH || 'claude', body: `${header}\n\n${mail.body}`,
                cwd: deps.repo ?? process.env.ORGIAST_REPO ?? ownRepo, timeoutSeconds: 90, readOnly: true, spawnImpl: deps.spawnImpl });
            } catch (e) { result = { exitCode: null, outputTail: `実行失敗: ${redactSecrets(e.message)}` }; }
          }
          result = { ...result, outputTail: redactSecrets(result.outputTail || result.error || '(出力なし)').slice(-8000) };
          if (result.error) result.error = redactSecrets(result.error);
          writeJson(resultFile, result);
        }
        await request('mail-reply', { id: mail.id, from: label, resultBody: result.outputTail });
        log('sent', { action: 'auto-reply', id: mail.id, exitCode: result.exitCode, timedOut: result.timedOut || false });
      }
      fs.appendFileSync(processedFile, `${mail.id}\n`, { mode: 0o600 }); processed.add(mail.id); handled.push(mail.id);
    }
    out(options['--json'] ? JSON.stringify({ received, processed: handled }) : `受信=${received.length} / 処理=${handled.length}`);
    return 0;
  } finally { release(); }
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`fleet-mail: ${redactSecrets(error.message)}`); process.exitCode = 1; }
}
