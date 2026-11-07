#!/usr/bin/env node
// 返信キュー: kim 宛の未返信を耐久キューで管理し、状態遷移を守る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';

const VALID_CHANNELS = new Set(['discord', 'email', 'line', 'messenger']);

// 状態遷移表: { from → [to, ...] }
const TRANSITIONS = {
  queued: ['drafted'],
  drafted: ['presented', 'approved', 'edited', 'rejected', 'no-reply', 'queued'],
  presented: ['approved', 'edited', 'rejected', 'no-reply', 'queued'],
  approved: ['sent', 'failed', 'uncertain', 'queued'],
  edited: ['sent', 'failed', 'uncertain', 'queued'],
  rejected: ['queued'],
  'no-reply': ['queued'],
  sent: [],
  failed: [],
  uncertain: ['sent'],
};

// ── Paths and helpers ────────────────────────────────────────────────

function dir(home) {
  return path.join(home, '.claude', 'reply-queue');
}

function queueFile(home) {
  return path.join(dir(home), 'queue.json');
}

function lockFile(home) {
  return path.join(dir(home), 'queue.lock');
}

export function keyOf(item) {
  return `${item.channel}:${item.thread}:${item.message}`;
}

export function idOf(key) {
  return 'rq-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

function randHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function normalizeDiff(text) {
  return String(text).replace(/\s+/g, ' ').replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
}

export function diffRatio(a, b) {
  const na = normalizeDiff(a), nb = normalizeDiff(b);
  if (!na && !nb) return 0;
  if (!na || !nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  const minLen = Math.min(na.length, nb.length);
  if (maxLen === 0) return 0;
  let edits = 0;
  for (let i = 0; i < minLen; i++) { if (na[i] !== nb[i]) edits++; }
  edits += maxLen - minLen;
  return edits / maxLen;
}

// ── Lock ──────────────────────────────────────────────────────────────

function acquireLock(home, { waitMs = 10_000, staleMs = 300_000 } = {}) {
  fs.mkdirSync(dir(home), { recursive: true });
  const lock = lockFile(home);
  let fd;
  const deadline = Date.now() + waitMs;
  let delay = 10;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try { fs.unlinkSync(lock); continue; } catch { /* race */ }
        }
      } catch { /* lock vanished */ }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay, remaining));
      delay = Math.min(delay * 2, 500);
    }
  }
  if (fd === undefined) throw new Error('reply-queue: キューが使用中です');
  return () => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} };
}

function withLock(home, fn, lockOpts) {
  const release = acquireLock(home, lockOpts);
  try { return fn(); } finally { release(); }
}

// ── Read / Write ─────────────────────────────────────────────────────

function readQueue(home) {
  const file = queueFile(home);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, items: {} };
    throw error;
  }
}

function writeQueue(home, data) {
  fs.mkdirSync(dir(home), { recursive: true });
  const file = queueFile(home);
  const temp = `${file}.${randHex(8)}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* ok */ }
  }
}

function update(home, id, fn) {
  return withLock(home, () => {
    const data = readQueue(home);
    const item = data.items[id];
    if (!item) throw new Error(`reply-queue: ${id} が見つかりません`);
    fn(item);
    writeQueue(home, data);
    return item;
  });
}

// ── State validation ─────────────────────────────────────────────────

function validateTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed) throw new Error(`reply-queue: 状態 ${from} からの遷移は許可されていません`);
  if (from === to) return;
  if (!allowed.includes(to)) throw new Error(`reply-queue: ${from} → ${to} は許可されていません`);
}

// ── Exported functions ──────────────────────────────────────────────

export function replyQueueDir(home) {
  return dir(home);
}

export function enqueueItems(home, items, { now = new Date(), lockWaitMs } = {}) {
  return withLock(home, () => {
    const data = readQueue(home);
    const added = [];
    const duplicates = [];
    for (const raw of items) {
      if (!raw.channel || !VALID_CHANNELS.has(raw.channel)) throw new Error(`reply-queue: channel が不正です: ${raw.channel}`);
      if (!raw.thread || typeof raw.thread !== 'string') throw new Error('reply-queue: thread が必要です');
      if (!raw.message || typeof raw.message !== 'string') throw new Error('reply-queue: message が必要です');
      if (!raw.from || !raw.from.name) throw new Error('reply-queue: from.name が必要です');
      if (!raw.body || typeof raw.body !== 'string') throw new Error('reply-queue: body が必要です');
      const key = keyOf(raw);
      const id = idOf(key);
      if (data.items[id]) {
        duplicates.push(id);
        continue;
      }
      data.items[id] = {
        id, key,
        channel: raw.channel, thread: raw.thread, message: raw.message,
        from: { id: raw.from.id, name: raw.from.name, external: Boolean(raw.from.external) },
        receivedAt: raw.receivedAt || now.toISOString(),
        body: raw.body,
        context: raw.context || [],
        category: raw.category || null,
        caseId: raw.caseId || null,
        link: raw.link || null,
        state: 'queued',
        history: [{ at: now.toISOString(), state: 'queued' }],
      };
      added.push(id);
    }
    writeQueue(home, data);
    return { added, duplicates, ids: added };
  }, lockWaitMs ? { waitMs: lockWaitMs } : undefined);
}

export function listItems(home, filter = {}) {
  const data = withLock(home, () => readQueue(home));
  let items = Object.values(data.items);
  if (filter.state) items = items.filter(i => i.state === filter.state);
  if (filter.channel) items = items.filter(i => i.channel === filter.channel);
  if (filter.from) items = items.filter(i => i.from.name === filter.from);
  return items;
}

export function getItem(home, id) {
  return withLock(home, () => {
    const data = readQueue(home);
    const item = data.items[id];
    if (!item) throw new Error(`reply-queue: ${id} が見つかりません`);
    return item;
  });
}

export function saveDraft(home, id, { text, basedOn, examples = [], voiceVersion, now = new Date() }) {
  return update(home, id, item => {
    validateTransition(item.state, 'drafted');
    item.draft = {
      text,
      createdAt: now.toISOString(),
      basedOnMessageId: basedOn || item.message,
      examplesUsed: examples,
      ...(voiceVersion ? { voiceVersion } : {}),
    };
    item.state = 'drafted';
    item.history.push({ at: now.toISOString(), state: 'drafted' });
  });
}

export function present(home, id, { now = new Date() } = {}) {
  return update(home, id, item => {
    validateTransition(item.state, 'presented');
    item.state = 'presented';
    item.history.push({ at: now.toISOString(), state: 'presented' });
  });
}

export async function decide(home, id, { verdict, finalText, reason, now = new Date() }) {
  if (!['approved', 'edited', 'rejected', 'no-reply'].includes(verdict)) throw new Error(`reply-queue: verdict が不正です: ${verdict}`);
  if (verdict === 'edited' && (finalText === undefined || finalText === null)) throw new Error('reply-queue: edited の場合は finalText が必要です');
  let learning = null;
  const updated = update(home, id, item => {
    validateTransition(item.state, verdict);
    const final = verdict === 'approved' ? (item.draft ? item.draft.text : finalText || '') : (verdict === 'edited' ? finalText : null);
    const ratio = (verdict === 'approved' || verdict === 'edited') && item.draft && final != null
      ? diffRatio(item.draft.text, final) : null;
    item.decision = { verdict, finalText: final, reason: reason || null, at: now.toISOString() };
    item.state = verdict;
    item.history.push({ at: now.toISOString(), state: verdict, note: reason || undefined });
    learning = { final, ratio };
  });
  // ロック解放後に学習へ記録する（ロック中に await しない）。
  await recordLearningLine(home, { now, id, item: updated, verdict, final: learning.final, ratio: learning.ratio });
  return updated;
}

async function recordLearningLine(home, { now, id, item, verdict, final, ratio }) {
  try {
    // Try dynamic import for the learning module
    try {
      const { recordDecision } = await import('./reply-learning.mjs');
      recordDecision(home, item, { now, source: 'chat' });
      return;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      // Fall through to legacy implementation
    }

    const learningPath = path.join(home, '.claude', 'reply-learning', 'corrections.jsonl');
    fs.mkdirSync(path.dirname(learningPath), { recursive: true });
    const rec = {
      ts: now.toISOString(), itemId: id, key: item.key,
      channel: item.channel, from: { name: item.from.name, id: item.from.id, external: item.from.external },
      category: item.category, received: item.body,
      draft: item.draft ? item.draft.text : null,
      final, verdict, reason: item.decision?.reason || null,
      diffRatio: ratio, source: 'chat',
    };
    const line = JSON.stringify(rec) + '\n';
    let skip = false;
    try {
      const existing = fs.readFileSync(learningPath, 'utf8');
      const existingLines = existing.split('\n').filter(Boolean);
      for (const existingLine of existingLines) {
        try {
          const parsed = JSON.parse(existingLine);
          if (parsed.itemId === id && parsed.verdict === verdict && parsed.final === final) {
            skip = true;
            break;
          }
        } catch { /* invalid line, ignore */ }
      }
    } catch { /* first write */ }
    if (!skip) fs.appendFileSync(learningPath, line);
  } catch { /* learning 初期化前は無視 */ }
}

export function issueReceipt(home, id, { fetchLatest, now = new Date(), allowDrafted = false, kimId, selfId, botIds = [] } = {}) {
  return withLock(home, () => {
    const data = readQueue(home);
    const item = data.items[id];
    if (!item) throw new Error(`reply-queue: ${id} が見つかりません`);
    if (item.state === 'sent') return { ok: false, reason: 'already_sent' };
    const allowed = ['approved', 'edited'];
    if (allowDrafted) allowed.push('drafted');
    if (!allowed.includes(item.state)) {
      throw new Error(`reply-queue: receipt は ${allowed.join('|')} でのみ発行できます (現在: ${item.state})`);
    }
    const latest = fetchLatest(item);
    const after = item.draft?.basedOnMessageId || item.message;
    
    // Load kimId from file if not provided
    let actualKimId = kimId;
    if (!actualKimId) {
      try {
        const kimIdPath = path.join(home, '.claude', 'orgiast-discord-user-id.txt');
        if (fs.existsSync(kimIdPath)) {
          actualKimId = fs.readFileSync(kimIdPath, 'utf8').trim();
        }
      } catch { /* ignore */ }
    }
    actualKimId = actualKimId || '715210673642012733';
    
    const newMessages = latest.filter(m => {
      // Filter out messages at or before the "after" point
      if (m.id && after && /^\d+$/.test(String(m.id)) && /^\d+$/.test(String(after))) {
        if (BigInt(m.id) <= BigInt(after)) return false;
      }
      
      const isKim = String(m.authorId) === String(actualKimId);
      const isBot = m.bot === true || (selfId && String(m.authorId) === String(selfId)) || (botIds.length > 0 && botIds.includes(String(m.authorId)));
      return !isKim && !isBot;
    });
    if (newMessages.length > 0) {
      item.state = 'queued';
      item.history.push({ at: now.toISOString(), state: 'queued', note: `context_changed: ${String(newMessages[0].content || '').slice(0, 100)}` });
      writeQueue(home, data);
      return { ok: false, reason: 'context_changed', newMessages };
    }
    const receipt = {
      id: 'rc-' + randHex(12),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
      latestMessageId: after,
    };
    item.receipt = { ...(item.receipt || {}), ...receipt };
    writeQueue(home, data);
    return { ok: true, receipt };
  });
}

export function markSent(home, id, { receiptId, messageId, now = new Date() }) {
  return update(home, id, item => {
    validateTransition(item.state, 'sent');
    if (!item.receipt) throw new Error('reply-queue: receipt がありません');
    if (item.receipt.id !== receiptId) throw new Error('reply-queue: receipt ID が一致しません');
    if (Date.parse(item.receipt.expiresAt) <= now.getTime()) {
      const err = new Error('reply-queue: receipt の有効期限が切れています');
      err.exitCode = 5;
      throw err;
    }
    item.sent = { messageId, at: now.toISOString(), receiptId };
    item.state = 'sent';
    item.history.push({ at: now.toISOString(), state: 'sent' });
  });
}

export function markFailed(home, id, { reason, now = new Date() }) {
  return update(home, id, item => {
    validateTransition(item.state, 'failed');
    item.failure = { at: now.toISOString(), reason };
    item.state = 'failed';
    item.history.push({ at: now.toISOString(), state: 'failed', note: reason });
  });
}

export function markUncertain(home, id, { reason, now = new Date() }) {
  return update(home, id, item => {
    validateTransition(item.state, 'uncertain');
    item.failure = { at: now.toISOString(), reason };
    item.state = 'uncertain';
    item.history.push({ at: now.toISOString(), state: 'uncertain', note: reason });
  });
}

export function reconcile(home, id, { messageId, now = new Date() }) {
  return update(home, id, item => {
    if (item.state !== 'uncertain') throw new Error(`reply-queue: uncertain からのみ reconcile できます (現在: ${item.state})`);
    item.sent = {
      messageId,
      at: item.sent?.at || now.toISOString(),
      receiptId: item.sent?.receiptId || '',
    };
    item.state = 'sent';
    item.history.push({ at: now.toISOString(), state: 'sent', note: 'reconciled' });
  });
}

export function status(home, { now = new Date() } = {}) {
  const data = withLock(home, () => readQueue(home));
  const items = Object.values(data.items);
  const byState = {};
  const stateByChannel = {};
  let uncertain = 0;
  let holdUntil = 0;
  for (const item of items) {
    byState[item.state] = (byState[item.state] || 0) + 1;
    if (!stateByChannel[item.state]) stateByChannel[item.state] = {};
    stateByChannel[item.state][item.channel] = (stateByChannel[item.state][item.channel] || 0) + 1;
    if (item.state === 'uncertain') uncertain++;
    if (item.holdUntil && Date.parse(item.holdUntil) > now.getTime()) holdUntil++;
  }
  return {
    byState, stateByChannel, uncertain, holdUntil,
    unreadable: ['discord: kim 個人 DM のうち Bot が参加していないもの（ユーザートークン方式は Discord 規約違反のため収集対象外）'],
  };
}

// ── CLI ───────────────────────────────────────────────────────────────

async function replyQueueCli(args = process.argv.slice(2), { home = process.env.ORGIAST_HOME || os.homedir(), stdout = console.log, stderr = console.error } = {}) {
  const cmd = args[0];
  if (!cmd) throw new Error('使い方: node tools/reply-queue.mjs <enqueue|list|show|draft|present|decide|receipt|mark-sent|mark-failed|mark-uncertain|reconcile|status> [...]');

  const val = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const has = flag => args.includes(flag);

  if (cmd === 'enqueue') {
    const file = val('--file', '');
    if (!file) throw new Error('--file が必要です');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(raw) ? raw : (raw.items || [raw]);
    const lockWaitMs = val('--lock-wait-ms', undefined);
    stdout(JSON.stringify(enqueueItems(home, items, { lockWaitMs })));
  } else if (cmd === 'list') {
    const filter = {};
    if (has('--state')) filter.state = val('--state');
    if (has('--channel')) filter.channel = val('--channel');
    if (has('--from')) filter.from = val('--from');
    const items = listItems(home, filter);
    if (has('--brief')) {
      stdout(JSON.stringify(items.map(i => ({
        id: i.id, key: i.key, state: i.state, from: i.from,
        receivedAt: i.receivedAt, summary: (i.body || '').slice(0, 60),
      }))));
    } else {
      stdout(JSON.stringify(items));
    }
  } else if (cmd === 'show') {
    const id = args[1];
    if (!id) throw new Error('show <id> が必要です');
    stdout(JSON.stringify(getItem(home, id), null, 2));
  } else if (cmd === 'draft') {
    const id = args[1];
    if (!id) throw new Error('draft <id> が必要です');
    const file = val('--file', '');
    if (!file) throw new Error('--file が必要です');
    const text = fs.readFileSync(file, 'utf8');
    const examples = has('--examples') ? val('--examples').split(',').filter(Boolean) : [];
    const basedOn = val('--based-on', undefined);
    const voiceVersion = val('--voice-version', undefined);
    const result = saveDraft(home, id, { text, basedOn, examples, voiceVersion });
    stdout(JSON.stringify({ id: result.id, state: result.state }));
  } else if (cmd === 'present') {
    const ids = args.slice(1).filter(a => !a.startsWith('--'));
    if (!ids.length) throw new Error('present <id>... が必要です');
    const results = ids.map(id => present(home, id));
    stdout(JSON.stringify(results.map(r => ({ id: r.id, state: r.state }))));
  } else if (cmd === 'decide') {
    const id = args[1];
    if (!id) throw new Error('decide <id> が必要です');
    const verdict = val('--verdict', '');
    if (!verdict) throw new Error('--verdict が必要です');
    let finalText = null;
    if (verdict === 'edited') {
      const file = val('--final-file', '');
      if (!file) throw new Error('edited の場合は --final-file が必要です');
      finalText = fs.readFileSync(file, 'utf8');
    }
    const reason = val('--reason', null);
    const result = await decide(home, id, { verdict, finalText, reason });
    stdout(JSON.stringify({ id: result.id, state: result.state }));
  } else if (cmd === 'receipt') {
    const id = args[1];
    if (!id) throw new Error('receipt <id> が必要です');
    const latestFile = val('--latest-file', null);
    const allowDrafted = has('--allow-drafted');
    const item = getItem(home, id);

    if (latestFile) {
      const result = issueReceipt(home, id, {
        fetchLatest: () => JSON.parse(fs.readFileSync(latestFile, 'utf8')),
        allowDrafted,
      });
      if (!result.ok && result.reason === 'already_sent') { stderr(JSON.stringify(result)); process.exit(4); }
      if (!result.ok && result.reason === 'context_changed') { stderr(JSON.stringify(result)); process.exit(3); }
      stdout(JSON.stringify(result));
    } else if (item.channel === 'discord') {
      const { readToken } = await import('./discord-task-digest.mjs');
      // 一時 home（ORGIAST_HOME）で検証するときもトークンは実 home から読めるようにする。
      let auth = readToken(home);
      if (!auth.token && home !== os.homedir()) auth = readToken(os.homedir());
      if (!auth.token) throw new Error('Discord Bot トークンが設定されていません');
      const after = item.draft?.basedOnMessageId || item.message;
      const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(item.thread)}/messages?after=${encodeURIComponent(after)}&limit=50`, {
        headers: { Authorization: `Bot ${auth.token}`, 'User-Agent': 'DiscordBot (orgiast-reply-queue, 1.0)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Discord API ${response.status}`);
      const messages = await response.json();
      const latest = Array.isArray(messages) ? messages.map(m => ({
        id: m.id, authorId: m.author?.id || '', authorName: m.author?.username || '',
        ts: m.id, content: m.content || '', bot: m.author?.bot || false,
      })) : [];
      const result = issueReceipt(home, id, { fetchLatest: () => latest, allowDrafted });
      if (!result.ok && result.reason === 'already_sent') { stderr(JSON.stringify(result)); process.exit(4); }
      if (!result.ok && result.reason === 'context_changed') { stderr(JSON.stringify(result)); process.exit(3); }
      stdout(JSON.stringify(result));
    } else {
      throw new Error('reply-queue: このチャネルには --latest-file が必要です');
    }
  } else if (cmd === 'mark-sent') {
    const id = args[1];
    if (!id) throw new Error('mark-sent <id> が必要です');
    const receiptId = val('--receipt', '');
    const messageId = val('--message-id', '');
    if (!receiptId || !messageId) throw new Error('--receipt と --message-id が必要です');
    try {
      const result = markSent(home, id, { receiptId, messageId });
      stdout(JSON.stringify({ id: result.id, state: result.state }));
    } catch (error) {
      if (error.exitCode === 5) { stderr(JSON.stringify({ ok: false, reason: 'receipt_expired' })); process.exit(5); }
      throw error;
    }
  } else if (cmd === 'mark-failed') {
    const id = args[1];
    if (!id) throw new Error('mark-failed <id> が必要です');
    const reason = val('--reason', '');
    if (!reason) throw new Error('--reason が必要です');
    const result = markFailed(home, id, { reason });
    stdout(JSON.stringify({ id: result.id, state: result.state }));
  } else if (cmd === 'mark-uncertain') {
    const id = args[1];
    if (!id) throw new Error('mark-uncertain <id> が必要です');
    const reason = val('--reason', '');
    if (!reason) throw new Error('--reason が必要です');
    const result = markUncertain(home, id, { reason });
    stdout(JSON.stringify({ id: result.id, state: result.state }));
  } else if (cmd === 'reconcile') {
    const id = args[1];
    if (!id) throw new Error('reconcile <id> が必要です');
    const messageId = val('--message-id', '');
    if (!messageId) throw new Error('--message-id が必要です');
    const result = reconcile(home, id, { messageId });
    stdout(JSON.stringify({ id: result.id, state: result.state }));
  } else if (cmd === 'status') {
    stdout(JSON.stringify(status(home), null, 2));
  } else {
    throw new Error(`不明なコマンド: ${cmd}`);
  }
}

if (isEntry(import.meta.url)) {
  replyQueueCli().catch(error => { 
    const exitCode = error.exitCode || (error.message?.includes('使用中') ? 2 : (error.message?.includes('許可されていません') ? 2 : 1));
    console.error(error.message); 
    process.exitCode = exitCode; 
  });
}
