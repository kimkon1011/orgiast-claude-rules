#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(os.homedir(), '.claude', 'watchers');

export function execFile(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function jst(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export function formatDm(watch, message) {
  const received = jst(message.internalDate ? Number(message.internalDate) : message.date) || '日時不明';
  const opening = /^satou@/iu.test(watch.notify)
    ? `佐藤さん、${watch.label} からメールの返信が届きました。`
    : `お疲れさまです。${watch.label} からメールの返信が届きました。`;
  const excerpt = String(message.body || message.snippet || '').trim().slice(0, 800);
  return `${opening}\n受信: ${received}\n差出人: ${message.from || ''}\n件名: ${message.subject || ''}\n----- 本文（先頭800字）-----\n${excerpt}\n----- ここまで -----\nGmail（${watch.user} で開く）: https://mail.google.com/mail/?authuser=${encodeURIComponent(watch.user)}#all/${message.threadId}\nこのあと AI が返信案を作り、このDMで送信確認を取ります。`;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}
async function appendLog(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
}

async function defaultSearch(watch) {
  const result = await execFile(process.execPath, [path.join(HERE, 'gmail-search.mjs'), '--query', watch.query, '--user', watch.user, '--max', '10', '--body']);
  if (result.code !== 0) throw new Error(`gmail-search failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed.messages)) throw new Error('gmail-search output has no messages array');
  return parsed.messages;
}
async function defaultSendDm(watch, body) {
  const file = path.join(os.tmpdir(), `reply-notify-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(file, body, 'utf8');
  try {
    const result = await execFile(process.execPath, [path.join(HERE, 'discord-dm.mjs'), watch.notify, '--body-file', file, '--internal-opt-in', '--no-copy-kim']);
    let parsed;
    try { parsed = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)); } catch { parsed = null; }
    return { delivered: result.code === 0 && parsed?.delivered === true, code: result.code };
  } finally { await fs.rm(file, { force: true }); }
}
async function defaultAddInbox(watch, message) {
  const file = path.join(os.tmpdir(), `reply-notify-inbox-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(file, `${watch.label} から返信メールを受信し、${watch.notify} へDiscord DM通知済み。message id: ${message.id}`, 'utf8');
  try {
    await execFile(process.execPath, [path.join(HERE, 'kim-inbox.mjs'), '--add', 'info', '--body-file', file, '--source', 'reply-notify', '--dedupe-key', `reply-notify:${message.id}`]);
  } finally { await fs.rm(file, { force: true }); }
}

export async function runWatcher(options = {}) {
  const configFile = options.configFile || path.join(DEFAULT_DIR, 'reply-notify.json');
  const stateFile = options.stateFile || path.join(DEFAULT_DIR, 'reply-notify-state.json');
  const logFile = options.logFile || path.join(DEFAULT_DIR, 'reply-notify.log');
  const now = options.now || new Date();
  const dryRun = options.dryRun === true;
  const config = options.config || await readJson(configFile, { watches: [] });
  const state = options.state || await readJson(stateFile, { notifiedMessageIds: [] });
  state.notifiedMessageIds ||= [];
  const notified = new Set(state.notifiedMessageIds);
  const today = jst(now).slice(0, 10);
  const summary = { searched: 0, notified: 0, skipped: 0, failed: 0, dryRun };
  for (const watch of config.watches || []) {
    if (watch.until && today > watch.until) { summary.skipped++; await appendLog(logFile, { watch: watch.id, result: 'expired' }); continue; }
    let messages;
    try { messages = await (options.search || defaultSearch)(watch); summary.searched += messages.length; }
    catch (error) { summary.failed++; await appendLog(logFile, { watch: watch.id, result: 'search-failed', error: error.message.slice(0, 200) }); continue; }
    for (const message of messages) {
      if (!message.id || notified.has(message.id)) { summary.skipped++; continue; }
      const body = formatDm(watch, message);
      if (dryRun) { (options.output || console.log)(body); await appendLog(logFile, { watch: watch.id, id: message.id, result: 'dry-run' }); continue; }
      try {
        const result = await (options.sendDm || defaultSendDm)(watch, body);
        if (!result?.delivered) throw new Error(`DM not delivered (exit ${result?.code ?? 'unknown'})`);
        notified.add(message.id); state.notifiedMessageIds = [...notified]; await writeJson(stateFile, state);
        summary.notified++; await appendLog(logFile, { watch: watch.id, id: message.id, result: 'delivered' });
        try { await (options.addInbox || defaultAddInbox)(watch, message); }
        catch (error) { await appendLog(logFile, { watch: watch.id, id: message.id, result: 'inbox-failed', error: error.message.slice(0, 200) }); }
      } catch (error) { summary.failed++; await appendLog(logFile, { watch: watch.id, id: message.id, result: 'dm-failed', error: error.message.slice(0, 200) }); }
    }
  }
  if (!options.state) await writeJson(stateFile, state);
  (options.output || console.log)(JSON.stringify(summary));
  return { summary, state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWatcher({ dryRun: process.argv.includes('--dry-run') }).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
