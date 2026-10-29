#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { resolveOwner } from './lib/fleet-owner.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
const exec = promisify(execFile);
const directory = home => path.join(home, '.claude/kim-inbox');
const clean = value => redactSecrets(String(value ?? '')).slice(0, 4000);
const validId = id => /^ki-\d{14}-[a-f0-9]{4}$/.test(id);
export const CONTEXT_LIMIT = 1800;
export function isKimSeat(home) {
  const label = resolveFleetLabel(home, { hostname: os.hostname() });
  return label === 'kim-PC' || resolveOwner({ home, label }).toLowerCase() === 'kim@orgiast.jp';
}
function save(home, item) {
  const file = path.join(directory(home), `${item.id}.json`);
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(item, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
// 同じ項目の回答・表示更新を直列化し、古い表示更新が回答を上書きしない。
function locked(home, key, fn) {
  fs.mkdirSync(directory(home), { recursive: true });
  const lock = path.join(directory(home), `${key}.lock`);
  let fd;
  for (let n = 0; n < 100; n++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (pid > 0) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') fs.unlinkSync(lock); } }
      } catch { /* 所有者が不明ならロックを奪わない。 */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (fd === undefined) throw new Error('kim-inbox: 台帳が使用中です');
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function update(home, id, fn) {
  if (!validId(id)) throw new Error('kim-inbox: ID が不正です');
  return locked(home, id, () => {
    const item = JSON.parse(fs.readFileSync(path.join(directory(home), `${id}.json`), 'utf8'));
    fn(item); save(home, item); return item;
  });
}
function create(home, { kind = 'info', text, source = '', from = resolveFleetLabel(home, { hostname: os.hostname() }), forwardMailId = null }) {
  if (!['ask', 'info'].includes(kind)) throw new Error('kind は ask または info');
  fs.mkdirSync(directory(home), { recursive: true });
  const createdAt = new Date().toISOString();
  for (;;) {
    const id = `ki-${createdAt.replace(/\D/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
    const item = { id, createdAt, kind, source: clean(source), from: clean(from), text: clean(text), status: 'open', shownSessions: [], shownCount: 0, lastShownAt: null, answeredAt: null, answer: null, answerSession: null, forwardMailId, forwardError: null };
    try { fs.writeFileSync(path.join(directory(home), `${id}.json`), JSON.stringify(item, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return item; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
export async function addItem(home, options) {
  const item = create(home, options);
  if (isKimSeat(home)) return item;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-'));
  try {
    const file = path.join(temp, 'body.txt');
    fs.writeFileSync(file, item.text, { mode: 0o600 });
    const { stdout } = await (options.execImpl ?? exec)(process.execPath, [fileURLToPath(new URL('./fleet-mail.mjs', import.meta.url)), '--send', '--to', 'kim-PC', '--kind', 'note', '--why', `[kim-inbox:${item.kind}] ${item.text.split(/\r?\n/)[0].slice(0, 60)}`, '--body-file', file], { encoding: 'utf8', windowsHide: true, timeout: 60000, signal: options.signal, env: { ...process.env, ORGIAST_HOME: home } });
    const id = stdout.trim().match(/^(?:送信済み: )?(mail-[A-Za-z0-9-]+)$/m)?.[1];
    if (!id) throw new Error('転送先のメールIDを取得できません');
    return update(home, item.id, current => { current.status = 'forwarded'; current.forwardMailId = id; });
  } catch (error) {
    return update(home, item.id, current => { current.forwardError = clean(error.message); });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
export function listItems(home, { status } = {}) {
  let files;
  try { files = fs.readdirSync(directory(home)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter(f => validId(f.replace(/\.json$/, '')) && f.endsWith('.json')).flatMap(f => {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(directory(home), f), 'utf8'));
      const valid = validId(item.id) && ['ask', 'info'].includes(item.kind) && typeof item.createdAt === 'string'
        && Number.isFinite(Date.parse(item.createdAt)) && typeof item.text === 'string'
        && Array.isArray(item.shownSessions) && Number.isFinite(item.shownCount);
      return valid && (!status || item.status === status) ? [item] : [];
    }
    catch { return []; } // 破損した1件で他の未回収項目を隠さない。
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function answerItem(home, id, answer, sessionId = '') {
  return update(home, id, item => { item.status = 'answered'; item.answer = clean(answer); item.answeredAt = new Date().toISOString(); item.answerSession = clean(sessionId); });
}
export function markSeen(home, id) {
  return update(home, id, item => { if (item.kind !== 'info') throw new Error('ask は --answer で返答を記録してください'); item.status = 'seen'; });
}
export function dropItem(home, id, reason) {
  if (!String(reason ?? '').trim()) throw new Error('取り下げ理由が必要です');
  return update(home, id, item => { item.status = 'dropped'; item.answer = clean(reason); });
}
const inboxDir = home => path.join(home, '.claude/fleet-inbox');
const readJsonFile = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// fleet-mail.mjs と同じロック（<file>.lock を wx で取得）で受信ファイルを完了にし、サーバー同期は
// fleet-mail の pendingServer キューに委ねる。fleet-mail.mjs を import すると
// notify-kim -> kim-inbox -> fleet-mail -> … -> notify-kim の動的循環（exit 13）になるため直接書く。
function ackInboxFile(file) {
  const lock = `${file}.lock`;
  let fd;
  for (let n = 0; n < 20 && fd === undefined; n++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' && !['EPERM', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (fd === undefined) throw new Error('受信ファイルが使用中です');
  try {
    const current = readJsonFile(file);
    if (!current || current.status === 'done') return false;
    const at = new Date().toISOString();
    const next = { ...current, status: 'done', ackAt: at, readAt: current.readAt || at, pendingServer: [...new Set([...(current.pendingServer || []), 'ack'])] };
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n'); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
    return true;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export async function ingestFleetMail(home) {
  if (!isKimSeat(home)) return [];
  let files;
  try { files = fs.readdirSync(inboxDir(home)).filter(f => /^mail-[A-Za-z0-9-]+\.json$/.test(f)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const imported = [];
  const skipped = path.join(directory(home), '.skipped');
  for (const name of files) {
    const id = name.slice(0, -5);
    // 対象外と判定済みのメールは毎プロンプト読み直さない（古い受信箱は数千件になる）。
    if (fs.existsSync(path.join(skipped, id))) continue;
    const file = path.join(inboxDir(home), name);
    const mail = readJsonFile(file);
    if (!mail) continue;
    const kind = /^\[kim-inbox:(ask|info)\]/.exec(mail.why ?? '')?.[1];
    if (!kind) {
      fs.mkdirSync(skipped, { recursive: true });
      try { fs.writeFileSync(path.join(skipped, id), '', { flag: 'wx', mode: 0o600 }); } catch { /* 既に記録済み */ }
      continue;
    }
    const marker = path.join(directory(home), '.ingested', id);
    locked(home, 'ingest', () => {
      if (fs.existsSync(marker)) return;
      // 作成直後に終了しても forwardMailId から再発見し、二重起票を防ぐ。
      const item = listItems(home).find(i => i.forwardMailId === id) ?? create(home, { kind, text: mail.body, from: mail.from, source: 'fleet-mail', forwardMailId: id });
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, item.id, { flag: 'wx', mode: 0o600 });
      imported.push(item);
    });
    // 次回も試せるようマーカー確認とは独立。
    try { ackInboxFile(file); }
    catch (error) { console.error(`kim-inbox: 取込済みメールの確認を次回再試行: ${clean(error.message).replace(/[\r\n]+/g, ' ')}`); }
  }
  return imported;
}
export function selectContext(items, { sessionId = '', now = Date.now() } = {}) {
  const pending = items.filter(i => i.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const asks = pending.filter(i => i.kind === 'ask'), infos = pending.filter(i => i.kind === 'info');
  if (!pending.length) return '';
  let text = `[kim-inbox 未回収 ask ${asks.length} 件 / 未確認 info ${infos.length} 件] kim への報告は Discord ではなくこのセッションで行う（kim 2026-10-27）。ask は kim の返答を会話で受け取り記録するまで毎プロンプト再提示される。セッションを閉じても台帳に残り次セッションで再提示される。\n`;
  const footer = '一覧: node tools/kim-inbox.mjs --list --open';
  for (const item of [...asks.slice(0, 5), ...infos.slice(0, 3)]) {
    const repeat = item.shownSessions.includes(sessionId);
    const body = repeat ? item.text.split(/\r?\n/)[0].slice(0, 120) : item.text.slice(0, 600);
    const heading = clean(`■ ${item.kind} ${item.id} (${Math.max(0, Math.floor((now - Date.parse(item.createdAt)) / 86400000))}日前 from=${item.from} source=${item.source})`).slice(0, 220);
    const command = item.kind === 'ask' ? `→ kim に提示して返答をもらい: node tools/kim-inbox.mjs --answer ${item.id} --body-file <返答ファイル>` : `→ kim に伝えたら: node tools/kim-inbox.mjs --seen ${item.id}`;
    const room = CONTEXT_LIMIT - text.length - footer.length - heading.length - command.length - 3;
    if (room < 1) break;
    text += `${heading}\n${clean(body).slice(0, room)}\n${command}\n`;
    item.shownSessions = [...new Set([...item.shownSessions, sessionId])];
    item.shownCount++; item.lastShownAt = new Date(now).toISOString();
  }
  return redactSecrets(text + footer);
}
export async function main(args = process.argv.slice(2), { home = process.env.ORGIAST_HOME || os.homedir(), stdout = console.log, stderr = console.error, readStdin = readStdinWithTimeout } = {}) {
  const value = flag => args[args.indexOf(flag) + 1];
  try {
    if (args.includes('--context')) {
      const input = JSON.parse(await readStdin(100));
      const event = input.hook_event_name;
      if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return 0;
      const kim = isKimSeat(home);
      if (kim) await ingestFleetMail(home);
      const items = listItems(home, { status: 'open' }).filter(i => kim || i.forwardError);
      const counts = new Map(items.map(i => [i.id, i.shownCount]));
      const context = selectContext(items, { sessionId: String(input.session_id ?? '') });
      for (const item of items.filter(i => i.shownCount !== counts.get(i.id))) update(home, item.id, current => {
        current.shownSessions = [...new Set([...current.shownSessions, ...item.shownSessions])]; current.shownCount++; current.lastShownAt = item.lastShownAt;
      });
      if (context) stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
    } else if (args.includes('--add')) {
      const item = await addItem(home, { text: fs.readFileSync(value('--body-file'), 'utf8'), kind: args.includes('--kind') ? value('--kind') : 'info', source: args.includes('--source') ? value('--source') : '' });
      stdout(JSON.stringify({ id: item.id, status: item.status, forwarded: item.status === 'forwarded' }));
    } else if (args.includes('--answer')) stdout(JSON.stringify(answerItem(home, value('--answer'), fs.readFileSync(value('--body-file'), 'utf8'), process.env.CLAUDE_SESSION_ID || '')));
    else if (args.includes('--seen')) stdout(JSON.stringify(markSeen(home, value('--seen'))));
    else if (args.includes('--drop')) stdout(JSON.stringify(dropItem(home, value('--drop'), args.includes('--reason') ? value('--reason') : '')));
    else if (args.includes('--status') || args.includes('--list')) {
      const items = listItems(home, { status: args.includes('--open') || args.includes('--status') ? 'open' : undefined });
      if (args.includes('--status')) stdout(`kim-inbox: open ask ${items.filter(i => i.kind === 'ask').length} / open info ${items.filter(i => i.kind === 'info').length}\n最古: ${items.length ? `${items[0].id} ${items[0].text.split(/\r?\n/)[0].slice(0, 120)}` : 'なし'}`);
      else stdout(args.includes('--json') ? JSON.stringify(items) : items.map(i => `${i.id} ${i.kind} ${i.status} ${i.text.split(/\r?\n/)[0]}`).join('\n'));
    } else throw new Error('--add / --answer / --seen / --drop / --list / --status / --context を指定してください');
    return 0;
  } catch (error) { stderr(`kim-inbox: ${clean(error.message).replace(/[\r\n]+/g, ' ')}`); return args.includes('--context') ? 0 : 1; }
}
if (isEntry(import.meta.url)) process.exitCode = await main();
