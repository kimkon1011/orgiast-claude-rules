#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAccounts, listChats, listMessages } from './beeper-api.mjs';
import { searchGmail } from './gmail-search.mjs';
import { isEntry } from './is-entry.mjs';
import { recordRun } from './lib/change-gate.mjs';

export const MAILBOXES = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return structuredClone(fallback); throw e; } };
export function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(tmp, file); }
function withFileLock(file, action) { let fd; for (let i = 0; i < 300; i++) { try { fd = fs.openSync(file, 'wx', 0o600); break; } catch (e) { if (e.code !== 'EEXIST') throw e; try { if (Date.now() - fs.statSync(file).mtimeMs > 60_000) fs.unlinkSync(file); } catch {} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } } if (fd === undefined) throw new Error('summary_lock_busy'); try { return action(); } finally { fs.closeSync(fd); try { fs.unlinkSync(file); } catch {} } }
const arr = v => Array.isArray(v) ? v : v?.items || [];
const ts = v => Number.isFinite(Number(v)) ? Number(v) : Date.parse(v);
const safeCode = e => String(e?.status || e?.code || e?.message || 'read_failed').slice(0, 80);
const itemKey = i => `${i.source}:${i.id}`;
const threadKey = i => i.kind === 'beeper' ? `beeper:${i.chatId}` : `gmail:${i.mailbox}:${i.threadId}`;
export const initialState = () => ({ version: 1, sources: {}, seen: {}, threadRoutes: {}, dispatches: [], unknown: [], digests: {} });

// Clean up old state entries
export function cleanupState(state, now) {
  // Remove seen entries older than 14 days
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60_000;
  for (const [key, timestamp] of Object.entries(state.seen)) {
    if (timestamp < fourteenDaysAgo) {
      delete state.seen[key];
    }
  }

  // Remove unknown entries older than 14 days based on reportedAt
  state.unknown = state.unknown.filter(entry => {
    const reportedAt = entry.reportedAt || entry.time;
    if (!reportedAt) return true; // Keep entries without timestamps
    return Date.parse(reportedAt) >= fourteenDaysAgo;
  });
}

export function isGmailNoise(m, config) {
  const from = String(m.from || '').toLowerCase();
  const subject = String(m.subject || '');
  const labels = (m.labels || []).map(x => String(x).toUpperCase());
  const selfSenders = ['seisaku-team@orgiast.jp', 'kim@orgiast.jp'];
  if (selfSenders.some(s => from.includes(s))) return false;
  if (!!m.listUnsubscribe) return true;
  if (/(^|[<@._+-])(no-?reply|noreply|do-?not-?reply)/i.test(from)) return true;
  if (labels.some(x => x === 'CATEGORY_PROMOTIONS' || x === 'CATEGORY_SOCIAL')) return true;
  const senders = config.noiseSenders || [];
  if (senders.some(p => new RegExp(p, 'i').test(from))) return true;
  const subjects = config.noiseSubjects || [];
  if (subjects.some(p => new RegExp(p, 'i').test(subject))) return true;
  return false;
}

export async function collectNew({ state, config, since, until, deps, checkpoint = () => {}, stop = () => {} }) {
  const items = [], failures = [], counts = { beeper: 0, gmail: 0, noise: 0 };
  const add = item => { const key = itemKey(item); if (!state.seen[key]) { state.seen[key] = until; items.push(item); counts[item.kind === 'beeper' ? 'beeper' : 'gmail']++; } };
  const beeperFrom = state.sources.beeper ?? since;
  try {
    stop(); const accounts = arr(await deps.getAccounts());
    const excluded = new Set(config.excludeNetworks || []), isExcluded = value => excluded.has(String(value || ''));
    const excludedIds = new Set(accounts.filter(a => [a.network, a.bridge?.type, a.name, a.displayName].some(isExcluded)).map(a => a.accountID || a.id).filter(Boolean));
    const allowedIds = new Set(accounts.filter(a => !excludedIds.has(a.accountID || a.id)).map(a => a.accountID || a.id).filter(Boolean));
    let cursor; const cursors = new Set(); let beeperFailed = false;
    do {
      stop(); const page = await deps.listChats({ limit: 200, cursor, direction: cursor ? 'before' : undefined });
      for (const chat of arr(page)) {
        const network = chat.network || accounts.find(a => (a.accountID || a.id) === chat.accountID)?.network || '';
        if (isExcluded(network) || isExcluded(chat.accountName) || isExcluded(chat.title) || excludedIds.has(chat.accountID) || (allowedIds.size && chat.accountID && !allowedIds.has(chat.accountID))) continue;
        if (!chat.lastActivity) continue;
        if (ts(chat.lastActivity) < beeperFrom - 60_000) continue;
        try {
          let mc; const seenCursors = new Set();
          do {
            stop(); const mp = await deps.listMessages(chat.id, { limit: 100, cursor: mc, direction: 'before' }); const rows = arr(mp);
            for (const m of rows) {
              const at = ts(m.timestamp || m.sortKey);
              if (m.isSender || m.isDeleted || !Number.isFinite(at) || at < beeperFrom - 60_000 || at > until) continue;
              add({ kind: 'beeper', source: `beeper:${chat.id}`, id: String(m.id || m.sortKey), chatId: chat.id, network, title: chat.title || '', sender: m.senderName || m.senderID || '', time: new Date(at).toISOString(), text: String(m.text || '') });
            }
            if (!mp.hasMore || rows.some(m => ts(m.timestamp || m.sortKey) < beeperFrom - 60_000)) break;
            mc = mp.oldestCursor; if (!mc || seenCursors.has(mc)) throw new Error('invalid_message_cursor'); seenCursors.add(mc);
          } while (mc);
        } catch (e) { beeperFailed = true; failures.push({ source: `beeper:${chat.id}`, code: safeCode(e) }); }
      }
      if (!page.hasMore) break; cursor = page.oldestCursor; if (!cursor || cursors.has(cursor)) throw new Error('invalid_chat_cursor'); cursors.add(cursor);
    } while (cursor);
    if (!beeperFailed) { state.sources.beeper = until; checkpoint(); }
  } catch (e) { failures.push({ source: 'beeper', code: safeCode(e) }); }

  for (const mailbox of MAILBOXES) {
    const source = `gmail:${mailbox}`, from = state.sources[source] ?? since;
    try {
      let pageToken; const pageTokens = new Set();
      do {
        stop(); const result = await deps.searchGmail({ user: mailbox, query: `after:${Math.floor((from - 60_000) / 1000)} -in:sent -in:chats -in:spam -in:trash`, max: 100, pageToken, withBody: true, bodyLimit: 12000, concurrency: 5, skipId: id => !!state.seen[`${source}:${id}`] });
        for (const m of result.messages || []) {
          const at = Number(m.internalDate) || Date.parse(m.date); if (!Number.isFinite(at) || at < from - 60_000 || at > until) continue;
          const base = { kind: 'gmail', source, id: m.id, mailbox, threadId: m.threadId, title: m.subject || '', sender: m.from || '', time: new Date(at).toISOString(), text: String(m.body || m.snippet || '') };
          state.seen[itemKey(base)] = until;
          if (isGmailNoise(m, config)) counts.noise++; else { items.push(base); counts.gmail++; }
        }
        checkpoint(); pageToken = result.nextPageToken;
        if (pageToken && pageTokens.has(pageToken)) throw new Error('repeated_gmail_cursor');
        if (pageToken) pageTokens.add(pageToken);
      } while (pageToken);
      state.sources[source] = until; checkpoint();
    } catch (e) { failures.push({ source, code: safeCode(e) }); }
  }
  return { items, failures, counts };
}

export function ruleRoute(item, config, state) {
  const known = state.threadRoutes[threadKey(item)]; if (known && config.routes[known]) return known;
  const titleAndSender = `${item.title}\n${item.sender}`.toLowerCase();
  const fullText = `${item.title}\n${item.sender}\n${item.text}`.toLowerCase();
  for (const rule of config.rules || []) {
    if (rule.networks?.length && !rule.networks.some(v => String(v).toLowerCase() === String(item.network || '').toLowerCase())) continue;
    if ((rule.chatIds || []).includes(item.chatId)) return rule.route;
    const haystack = rule.matchBody ? fullText : titleAndSender;
    if (!(rule.includes || []).length || rule.includes.some(v => haystack.includes(String(v).toLowerCase()))) return rule.route;
  }
  return null;
}

export function parseRoute(raw, config) {
  try {
    const data = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] || raw);
    // Check confidence level - if less than 0.7, treat as unknown
    if (!Number.isFinite(Number(data.confidence)) || Number(data.confidence) < 0.7) return 'unknown';
    return config.routes[data.route] ? data.route : 'unknown';
  } catch { return 'unknown'; }
}

export async function routeItems(items, { config, state, classify, stop = () => {} }) {
  const groups = {}, unknown = [];
  const threadGroups = {}, routesByItem = new Map();
  for (const item of items) {
    stop();
    const route = ruleRoute(item, config, state);
    if (route) { routesByItem.set(item, route); continue; }
    const key = threadKey(item);
    if (!threadGroups[key]) threadGroups[key] = [];
    threadGroups[key].push(item);
  }
  for (const [key, threadItems] of Object.entries(threadGroups)) {
    let route;
    try { route = parseRoute(await classify(threadItems[0], config), config); } catch { route = 'unknown'; }
    if (route !== 'unknown') state.threadRoutes[key] = route;
    for (const item of threadItems) routesByItem.set(item, route);
  }
  for (const item of items) {
    const route = routesByItem.get(item);
    if (route === 'unknown') { unknown.push(item); continue; }
    if (config.routes[route]?.dispatch === false) continue;
    (groups[route] ||= []).push(item);
  }
  return { groups, unknown, routesByItem };
}

export function dispatchBody(route, items) {
  const lines = items.map(i => `- [${i.kind === 'beeper' ? i.network || 'Beeper' : i.mailbox}] ${i.title || '(件名なし)'} / ${i.sender || '(送信者不明)'} / ${i.time}\n  ${i.text.slice(0, 1500)}\n  ${i.kind === 'beeper' ? `chatID: ${i.chatId}` : `mailbox: ${i.mailbox} / threadId: ${i.threadId}`}`);
  return `受信ルーターが ${route} 宛ての新着を検出しました。\n\n${lines.join('\n\n')}\n\n経緯を確認し、返信案または次の行動を作る。社外への送信はしない（既存ルールどおり reply-queue / gmail-draft の下書き・承認経由。AI作成の一文は送信ツールが自動付与）。社内連絡も既存ルールに従う。完了したら fleet-mail の返信で「返信案あり/次の行動/不要」を1行で返す。\n`;
}

export function buildClassifyPrompt(item, config) {
  const routes = Object.entries(config.routes).map(([name, route]) => `${name}: ${route.description}`).join('\n');
  return `次の受信を担当分類してください。説明に明確に当てはまる業務の連絡だけ route を返してください。個人・家族・友人・雑談・判断がつかないものは unknown としてください。JSON {"route":"...","confidence":0.0} のみを返し、confidence は 0-1 の数値にしてください。\n\n利用可能なルート:\n${routes}\n\n件名:${item.title}\n送信者:${item.sender}\n本文:${item.text.slice(0, 3000)}`;
}

export function makeRuntimeDeps({ home, root = repoRoot } = {}) {
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 90_000, ...opts });
  return {
    getAccounts, listChats, listMessages, searchGmail,
    classify: (item, config) => {
      const dir = path.join(home, '.claude', 'inbound-router', 'prompts');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `classify-${process.pid}.txt`);
      fs.writeFileSync(file, buildClassifyPrompt(item, config));
      try {
        for (const provider of ['glm', 'deepseek', 'groq']) {
          const r = run(process.execPath, [path.join(root, 'tools', 'llm-ask.mjs'), '--provider', provider, '--prefer-provider', '--no-fallback', '--category', 'classification', '--max', '300', '--per-provider-timeout-ms', '18000', '--prompt-file', file]);
          if (r.status === 0) return r.stdout;
        }
        throw new Error('llm_failed');
      } finally {
        try { fs.unlinkSync(file); } catch {}
      }
    },
    sendFleet: ({ route, routeConfig, bodyFile }) => { const args = [path.join(root, 'tools', 'fleet-mail.mjs'), '--send', '--to', routeConfig.target, '--kind', 'prompt', '--exec', 'claude', '--exec-cwd', routeConfig.cwd, '--body-file', bodyFile, '--why', `[作業依頼] inbound-router ${route}`]; if (routeConfig.session) args.push('--resume', routeConfig.session); const r = run(process.execPath, args); if (r.status !== 0) throw new Error(`fleet_mail_${r.status}: ${String(r.stderr || '').slice(0, 200)}`); const id = r.stdout.match(/送信済み:\s*([A-Za-z0-9._-]+)/)?.[1]; if (!id) throw new Error('fleet_mail_id_missing'); return { id, method: 'fleet-mail' }; },
    statusFleet: id => { const r = run(process.execPath, [path.join(root, 'tools', 'fleet-mail.mjs'), '--sent-status', id]); if (r.status !== 0) return 'failed'; if (/^reply:/m.test(r.stdout) || /^status:\s*done\s*$/mi.test(r.stdout)) return 'done'; if (/^status:\s*expired\s*$/mi.test(r.stdout)) return 'expired'; if (/^status:\s*failed\s*$/mi.test(r.stdout)) return 'failed'; return 'pending'; }
  };
}

function dispatchDue(d, now) {
  return !['done', 'abandoned'].includes(d.status) && d.sentAt !== now
    && (['failed', 'expired'].includes(d.status) || now - d.sentAt >= 60 * 60_000);
}

export async function retryDispatches(state, { now, deps, config, dryRun, plans, failures = [] }) {
  for (const d of state.dispatches) {
    if (!dispatchDue(d, now)) continue;
    let status = await deps.statusFleet(d.id);
    if (status === 'done') { d.status = 'done'; continue; }
    if (now - d.sentAt < 60 * 60_000 && status !== 'failed' && status !== 'expired') continue;
    if (d.attempts >= 3) { d.status = 'abandoned'; state.unknown.push({ id: `abandoned:${d.id}`, reason: '渡したが未着手', route: d.route, itemKeys: d.itemKeys, time: new Date(now).toISOString() }); continue; }
    plans.push({ type: 'retry', route: d.route, itemKeys: d.itemKeys });
    if (!dryRun) {
      try {
        const sent = await dispatchGroup(d.route, d.items, { state, config, deps, now });
        d.id = sent.id; d.method = sent.method; d.sentAt = now; d.attempts++; d.status = 'sent';
      } catch (e) {
        d.attempts++;
        d.status = 'failed';
        d.lastError = String(e.message || e).slice(0, 200);
        d.sentAt = now;
        failures.push({ source: `retry:${d.route}`, code: safeCode(e) });
      }
    }
  }
}

async function dispatchGroup(route, items, { state, config, deps, now, root = repoRoot }) {
  const rc = config.routes[route], dir = path.join(path.dirname(state.__file), 'prompts'); fs.mkdirSync(dir, { recursive: true }); const bodyFile = path.join(dir, `${route}-${now}-${process.pid}.txt`); fs.writeFileSync(bodyFile, dispatchBody(route, items));
  const sent = await deps.sendFleet({ route, routeConfig: rc, bodyFile });
  return sent;
}

function digestSlot(now) { const d = new Date(now + 9 * 3600_000); const h = d.getUTCHours(); const slot = [21, 15, 9].find(x => h >= x); if (!slot) return null; return `${d.toISOString().slice(0, 10)}-${String(slot).padStart(2, '0')}`; }

function resolvePc(reportDir) {
  const pcFile = path.join(path.dirname(reportDir), 'gb-offload', 'pc-label.txt');
  if (fs.existsSync(pcFile)) {
    const raw = fs.readFileSync(pcFile, 'utf8');
    const stripped = raw.replace(/^\uFEFF/, '').trim();
    if (stripped) return stripped;
  }
  return os.hostname();
}

function buildDigestBody(pc, full, status, n, rows) {
  const header = `# inbound-router  PC=${pc}  ${full} JST  status=${status}  要判断=${n}`;
  const sections = `## 🚩要判断\n\n${rows.join('\n\n') || 'なし'}\n`;
  return `${header}\n\n${sections}`;
}

function escapePsQuote(s) {
  return s.replace(/'/g, "''");
}

export function writeDigest({ state, now, reportDir, force = false }) {
  const slot = force ? `forced-${now}` : digestSlot(now); if (!slot || state.digests[slot]) return null;
  const pending = state.unknown.filter(x => !x.reportedAt); if (!pending.length && !force) { state.digests[slot] = now; return null; }
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date(now + 9 * 3600_000).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const name = `inbound-router-${stamp.slice(0,8)}-${stamp.slice(8)}.md`;
  const file = path.join(reportDir, name);
  const jst = new Date(now + 9 * 3600_000), pad = n => String(n).padStart(2, '0');
  const short = `${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
  const full = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
  const pc = resolvePc(reportDir);
  const rows = pending.map(x => {
    const i = x.item || x;
    return `### ${i.title || i.reason || '要判断'}\n- 送信元: ${i.kind === 'gmail' ? i.mailbox : i.network || i.source || ''}\n- 送信者: ${i.sender || ''}\n- 時刻: ${i.time || ''}\n- 本文: ${String(i.text || '').slice(0, 200)}\n- 候補ルート: ${x.candidates?.join(', ') || x.route || 'unknown'}`;
  });
  const status = pending.length ? '要判断' : 'OK';
  const body = buildDigestBody(pc, full, status, pending.length, rows);
  const latest = path.join(reportDir, 'latest-inbound-router.md');

  // Try to use PowerShell mutex locking if common.ps1 exists
  const commonPs1 = path.join(path.dirname(reportDir), 'gb-offload', 'common.ps1');
  if (fs.existsSync(commonPs1)) {
    const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 90_000, ...opts });
    // Write only sections (no header) to temp for GB-WriteReport
    const sectionsOnly = `## 🚩要判断\n\n${rows.join('\n\n') || 'なし'}\n`;
    const tempBodyFile = path.join(os.tmpdir(), `inbound-router-body-${process.pid}.txt`);
    fs.writeFileSync(tempBodyFile, sectionsOnly, 'utf8');
    try {
      const psCmd = `& { . '${escapePsQuote(commonPs1)}'; GB-WriteReport -Job 'inbound-router' -Body (Get-Content -LiteralPath '${escapePsQuote(tempBodyFile)}' -Raw -Encoding UTF8) -Flags ${pending.length} -Status '${status}' }`;
      const psResult = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd]);
      if (psResult.status === 0) {
        // Extract report path from last non-empty line of stdout
        const stdoutLines = (psResult.stdout || '').split(/\r?\n/).filter(l => l.trim());
        const reportPath = stdoutLines.length > 0 ? stdoutLines[stdoutLines.length - 1].trim() : '';
        const targetFile = reportPath && fs.existsSync(reportPath) ? reportPath : file;
        // Write the correct body (single header + sections) to both target and latest
        fs.writeFileSync(targetFile, body, 'utf8');
        fs.writeFileSync(latest, body, 'utf8');
        // Verify latest
        const verifyContent = fs.readFileSync(latest, 'utf8');
        const headerLines = verifyContent.split(/\r?\n/).filter(l => l.startsWith('# inbound-router '));
        if (headerLines.length !== 1) throw new Error(`digest_header_count: expected 1, got ${headerLines.length}`);
        if (!headerLines[0].includes(`PC=${pc}`) || !headerLines[0].includes(`PC=${pc} `)) {
          // PC= の後が空でないことを確認
          const pcMatch = headerLines[0].match(/PC=(\S*)/);
          if (!pcMatch || !pcMatch[1]) throw new Error('digest_pc_empty');
        }
        if (!headerLines[0].includes(`要判断=${pending.length}`)) throw new Error('digest_flags_mismatch');
        pending.forEach(x => { x.reportedAt = now; });
        state.digests[slot] = now;
        return targetFile;
      }
      throw new Error(`GB-WriteReport failed: ${String(psResult.stderr || psResult.stdout).trim().slice(0, 200)}`);
    } finally {
      try { fs.unlinkSync(tempBodyFile); } catch {}
    }
  }

  // Fallback: write directly (no common.ps1)
  fs.writeFileSync(file, body, 'utf8');
  fs.writeFileSync(latest, body, 'utf8');
  const summary = path.join(reportDir, 'summary.md');
  withFileLock(`${summary}.lock`, () => {
    const old = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '';
    const summaryRows = new Map();
    for (const line of old.split(/\r?\n/)) {
      const match = line.match(/^\|\s*([a-z][\w-]*)\s*\|/);
      if (match && match[1] !== 'job') summaryRows.set(match[1], line);
    }
    summaryRows.set('inbound-router', `| inbound-router | ${short} | ${status} | ${pending.length} | ${name} |`);
    const next = `# gb-reports summary  PC=${pc}  updated ${full} JST\n(要判断>0 の行だけ latest-<job>.md の「🚩要判断」を読めばよい)\n\n| job | last | status | 要判断 | file |\n|---|---|---|---|---|\n${[...summaryRows].sort(([a],[b]) => a.localeCompare(b)).map(([,line]) => line).join('\n')}\n`;
    const tmp = `${summary}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, summary);
  });
  pending.forEach(x => { x.reportedAt = now; });
  state.digests[slot] = now;
  return file;
}

export async function run(options = {}, injected = {}) {
  const started = Date.now(), now = options.now ?? started, home = options.home || process.env.ORGIAST_HOME || os.homedir(), root = options.root || repoRoot;
  const dir = path.join(home, '.claude', 'inbound-router'), stateFile = options.stateFile || path.join(dir, 'state.json'), logFile = path.join(home, '.claude', 'logs', 'inbound-router.log'), config = options.config || readJson(path.join(root, 'config', 'inbound-router.json'), {}), deps = { ...makeRuntimeDeps({ home, root }), ...injected };
  const calls = { classify: 0, fleetSend: 0, fleetStatus: 0 };
  for (const [method, counter] of [['classify', 'classify'], ['sendFleet', 'fleetSend'], ['statusFleet', 'fleetStatus']]) {
    const original = deps[method];
    deps[method] = (...args) => { calls[counter]++; return original(...args); };
  }
  fs.mkdirSync(dir, { recursive: true }); const lock = path.join(dir, '.lock'); let fd;
  for (let attempt = 0; attempt < 2; attempt++) { try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); break; } catch (e) { if (e.code !== 'EEXIST') throw e; let pid; try { pid = Number(fs.readFileSync(lock, 'utf8')); process.kill(pid, 0); return { status: 'locked' }; } catch (check) { if (check.code === 'ESRCH' || !Number.isSafeInteger(pid)) { try { fs.unlinkSync(lock); } catch {} continue; } throw check; } } }
  if (fd === undefined) return { status: 'locked' };
  const state = readJson(stateFile, initialState()); state.__file = stateFile; const save = () => { const clean = { ...state }; delete clean.__file; writeJson(stateFile, clean); }; const deadline = started + 13 * 60_000; const stop = () => { if (Date.now() > deadline) throw Object.assign(new Error('budget'), { code: 'budget' }); };
  const plans = [];
  try {
    const since = now - (options.sinceMinutes || 60) * 60_000;
    if (Number.isFinite(options.sinceMinutes) && options.sinceMinutes > 0) {
      for (const source of ['beeper', ...MAILBOXES.map(mailbox => `gmail:${mailbox}`)]) {
        state.sources[source] = Math.min(state.sources[source] ?? since, since);
      }
    }

    // Clean up old state entries
    cleanupState(state, now);

    const collected = await collectNew({ state, config, since, until: now, deps, checkpoint: options.dryRun ? () => {} : save, stop });
    if (collected.items.length === 0 && !state.dispatches.some(d => dispatchDue(d, now))) {
      let digestFile = null; if (!options.dryRun) digestFile = writeDigest({ state, now, reportDir: options.reportDir || path.join(home, 'gb-reports'), force: options.digestNow });
      const report = { status: collected.failures.length ? 'partial' : 'ok', new: collected.counts, routed: {}, dispatches: 0, unknown: 0, failures: collected.failures, digestFile: digestFile ? path.basename(digestFile) : null, durationMs: Date.now() - started, calls, plans };
      if (!options.dryRun) { save(); fs.mkdirSync(path.dirname(logFile), { recursive: true }); if (!options.runnerLog) fs.appendFileSync(logFile, `${JSON.stringify(report)}\n`); }
      recordRun('inbound-router', { changed: false, llmInvoked: false, items: 0, note: report.status });
      return report;
    }
    const routed = await routeItems(collected.items, { config, state, classify: deps.classify, stop });
    for (const item of routed.unknown) state.unknown.push({ id: itemKey(item), item, candidates: Object.keys(config.routes), time: item.time });
    for (const [route, items] of Object.entries(routed.groups)) {
      plans.push({ type: 'dispatch', route, pc: config.routes[route].pc, count: items.length, itemKeys: items.map(itemKey) });
      if (!options.dryRun) {
        const record = { id: `pending-${route}-${now}`, method: 'fleet-mail', route, pc: config.routes[route].pc, itemKeys: items.map(itemKey), items, sentAt: now, attempts: 0, status: 'failed' }; state.dispatches.push(record); save();
        try { const sent = await dispatchGroup(route, items, { state, config, deps, now, root }); Object.assign(record, { id: sent.id, method: sent.method, attempts: 1, status: 'sent' }); save(); }
        catch (e) { collected.failures.push({ source: `dispatch:${route}`, code: safeCode(e) }); save(); }
      }
    }
    const failures = collected.failures;
    await retryDispatches(state, { now, deps, config, dryRun: options.dryRun, plans, failures });
    let digestFile = null; if (!options.dryRun) digestFile = writeDigest({ state, now, reportDir: options.reportDir || path.join(home, 'gb-reports'), force: options.digestNow });
    const preview = options.dryRun ? collected.items.map(item => ({ route: routed.routesByItem.get(item), title: item.title.slice(0, 30), sender: item.sender.slice(0, 20) })) : undefined;
    const report = { status: collected.failures.length ? 'partial' : 'ok', new: collected.counts, routed: Object.fromEntries(Object.entries(routed.groups).map(([k,v]) => [k,v.length])), dispatches: plans.length, unknown: routed.unknown.length, failures: collected.failures, digestFile: digestFile ? path.basename(digestFile) : null, durationMs: Date.now() - started, calls, plans, ...(preview ? { preview } : {}) };
    if (!options.dryRun) { save(); fs.mkdirSync(path.dirname(logFile), { recursive: true }); if (!options.runnerLog) fs.appendFileSync(logFile, `${JSON.stringify(report)}\n`); }
    recordRun('inbound-router', { changed: collected.items.length > 0, llmInvoked: calls.classify > 0, items: collected.items.length, note: report.status });
    return report;
  } catch (e) {
    const report = { status: 'failed', new: { beeper: 0, gmail: 0, noise: 0 }, routed: {}, dispatches: 0, unknown: 0, failures: [{ source: 'run', code: safeCode(e) }], digestFile: null, durationMs: Date.now() - started, calls, plans };
    if (!options.dryRun) { try { save(); } catch {} try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); if (!options.runnerLog) fs.appendFileSync(logFile, `${JSON.stringify(report)}\n`); } catch {} }
    return report;
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2), value = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
  run({ dryRun: args.includes('--dry-run'), runnerLog: args.includes('--runner-log'), digestNow: args.includes('--digest-now'), sinceMinutes: value('--since-minutes', undefined) }).then(r => { console.log(JSON.stringify(r)); if (!['ok', 'locked'].includes(r.status)) process.exitCode = 1; }).catch(e => { console.error(`inbound-router failed: ${safeCode(e)}`); process.exitCode = 1; });
}
