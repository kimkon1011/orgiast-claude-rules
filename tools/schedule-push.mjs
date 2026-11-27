#!/usr/bin/env node
/**
 * schedule-push.mjs — 電話・面談・期日など「時刻のある予定」を、
 * 分かった時点と開始（または枠の終了）の30分前に金さんへプッシュする。
 * 日単位の deadline-watch（GB-63 期日回収）では届かない、当日の時刻リマインド用。
 *
 * 使い方:
 *   node tools/schedule-push.mjs add --title "古川さんへ電話" --at 2026-11-21T14:00:00+09:00 [--remind-minutes 30] [--announce-now] [--window-end 2026-11-21T17:00:00+09:00] [--source discord]
 *   node tools/schedule-push.mjs tick [--dry-run] [--now 2026-11-21T13:30:00+09:00]
 *   node tools/schedule-push.mjs list
 *   node tools/schedule-push.mjs cancel --id <id>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isEntry } from './is-entry.mjs';

export const DEFAULT_REMIND_MINUTES = 30;
export const GRACE_AFTER_START_MS = 10 * 60 * 1000;
export const ANNOUNCE_TTL_MS = 2 * 60 * 60 * 1000;

export const ledgerDir = (home) => path.join(home, '.claude', 'schedule-push');
export const ledgerPath = (home) => path.join(ledgerDir(home), 'ledger.json');

export function defaultHome() {
  return process.env.ORGIAST_HOME || os.homedir();
}

export function emptyLedger() {
  return { version: 1, events: [] };
}

export function loadLedger(home, { fsImpl = fs } = {}) {
  const file = ledgerPath(home);
  try {
    const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const events = Array.isArray(raw?.events) ? raw.events : [];
    return { version: 1, events };
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyLedger();
    throw error;
  }
}

export function saveLedger(home, ledger, { fsImpl = fs } = {}) {
  const dir = ledgerDir(home);
  fsImpl.mkdirSync(dir, { recursive: true });
  const file = ledgerPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = { version: 1, events: ledger.events || [] };
  fsImpl.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fsImpl.renameSync(tmp, file);
  return payload;
}

function requiredIso(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} は ISO 8601 の日時で指定してください`);
  return new Date(time).toISOString();
}

export function addEvent(ledger, input, { now = new Date() } = {}) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('--title が必要です');
  const start = requiredIso(input.at || input.start, '--at');
  const remindMinutes = input.remindMinutes == null ? DEFAULT_REMIND_MINUTES : Number(input.remindMinutes);
  if (!Number.isFinite(remindMinutes) || remindMinutes < 0) throw new Error('--remind-minutes は 0 以上の数値です');
  const event = {
    id: String(input.id || randomUUID()),
    title,
    start,
    remindMinutes,
    source: String(input.source || '').trim(),
    status: 'scheduled',
    createdAt: now.toISOString(),
    announcedAt: null,
    remindedAt: null,
    windowEnd: input.windowEnd ? requiredIso(input.windowEnd, '--window-end') : null,
    announceAt: input.announceNow ? now.toISOString() : (input.announceAt ? requiredIso(input.announceAt, '--announce-at') : null),
  };
  const events = (ledger.events || []).filter((row) => row.id !== event.id);
  events.push(event);
  return { ...ledger, events };
}

export function cancelEvent(ledger, id) {
  if (!id) throw new Error('--id が必要です');
  let found = false;
  const events = (ledger.events || []).map((row) => {
    if (row.id !== id) return row;
    found = true;
    return { ...row, status: 'cancelled' };
  });
  if (!found) throw new Error(`予定が見つかりません: ${id}`);
  return { ...ledger, events };
}

export function duePushes(events, now = new Date()) {
  const t = now.getTime();
  const due = [];
  for (const event of events || []) {
    if (!event || event.status !== 'scheduled') continue;
    const startMs = Date.parse(event.start);
    if (!Number.isFinite(startMs)) continue;
    const remindMinutes = Number.isFinite(Number(event.remindMinutes)) ? Number(event.remindMinutes) : DEFAULT_REMIND_MINUTES;
    const windowEndMs = event.windowEnd ? Date.parse(event.windowEnd) : NaN;

    if (event.announceAt && !event.announcedAt) {
      const announceMs = Date.parse(event.announceAt);
      if (Number.isFinite(announceMs) && t >= announceMs && t < announceMs + ANNOUNCE_TTL_MS) {
        due.push({ event, kind: 'announce' });
      }
    }

    const reminderStart = startMs - remindMinutes * 60 * 1000;
    if (!event.remindedAt && t >= reminderStart && t < startMs + GRACE_AFTER_START_MS) {
      due.push({ event, kind: 'reminder' });
    }

    if (Number.isFinite(windowEndMs) && windowEndMs !== startMs && !event.windowRemindedAt) {
      const windowReminderStart = windowEndMs - remindMinutes * 60 * 1000;
      if (t >= windowReminderStart && t < windowEndMs + GRACE_AFTER_START_MS) {
        due.push({ event, kind: 'window-end' });
      }
    }
  }
  return due;
}

export function formatPush(item, now = new Date()) {
  const event = item.event;
  const start = new Date(event.start);
  const when = formatTokyo(start);
  if (item.kind === 'announce') {
    return {
      title: `予定が入りました: ${event.title}`,
      body: `${event.title}は ${when} です。時刻の${event.remindMinutes ?? DEFAULT_REMIND_MINUTES}分前にもう一度お知らせします。`,
    };
  }
  if (item.kind === 'window-end') {
    const end = formatTokyo(new Date(event.windowEnd));
    return {
      title: `まもなく枠の終了: ${event.title}`,
      body: `${event.title}の枠は ${end} までです。まだなら、このあとすぐ対応できますか。`,
    };
  }
  const started = now.getTime() >= Date.parse(event.start);
  return {
    title: started ? `予定の時刻です: ${event.title}` : `まもなく開始: ${event.title}`,
    body: started
      ? `${event.title}の開始時刻（${when}）です。`
      : `${event.title}は ${when} からです。${event.remindMinutes ?? DEFAULT_REMIND_MINUTES}分前のお知らせです。`,
  };
}

export function formatTokyo(date) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}/${get('month')}/${get('day')}（${get('weekday')}） ${get('hour')}:${get('minute')}`;
}

export function applyPush(ledger, item, { now = new Date() } = {}) {
  const events = (ledger.events || []).map((row) => {
    if (row.id !== item.event.id) return row;
    if (item.kind === 'announce') return { ...row, announcedAt: now.toISOString() };
    if (item.kind === 'window-end') return { ...row, windowRemindedAt: now.toISOString() };
    return { ...row, remindedAt: now.toISOString() };
  });
  return { ...ledger, events };
}

export async function tick(home, { now = new Date(), dryRun = false, notify, load = loadLedger, save = saveLedger } = {}) {
  let ledger = load(home);
  const due = duePushes(ledger.events, now);
  const sent = [];
  for (const item of due) {
    const message = formatPush(item, now);
    if (!dryRun && notify) await notify({ home, item, message, now });
    if (!dryRun) ledger = applyPush(ledger, item, { now });
    sent.push({ id: item.event.id, kind: item.kind, title: message.title, body: message.body });
  }
  if (!dryRun && sent.length) save(home, ledger);
  return { sent, dryRun: !!dryRun };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--announce-now') args.announceNow = true;
    else if (token.startsWith('--')) {
      const key = token.slice(2);
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} には値が必要です`);
      args[camel] = value;
      i += 1;
    } else args._.push(token);
  }
  return args;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home || (argv.includes('--home') ? argv[argv.indexOf('--home') + 1] : defaultHome());
  const filtered = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') { i += 1; continue; }
    filtered.push(argv[i]);
  }
  const args = parseArgs(filtered);
  const command = args._[0] || 'tick';
  const out = deps.out || console.log;
  if (command === 'add') {
    const ledger = addEvent(loadLedger(home, deps), {
      title: args.title,
      at: args.at,
      remindMinutes: args.remindMinutes,
      source: args.source,
      id: args.id,
      announceNow: args.announceNow,
      announceAt: args.announceAt,
      windowEnd: args.windowEnd,
    }, { now: args.now ? new Date(args.now) : new Date() });
    if (!args.dryRun) saveLedger(home, ledger, deps);
    const event = ledger.events.at(-1);
    out(JSON.stringify({ ok: true, event }, null, 2));
    return 0;
  }
  if (command === 'cancel') {
    const ledger = cancelEvent(loadLedger(home, deps), args.id);
    if (!args.dryRun) saveLedger(home, ledger, deps);
    out(JSON.stringify({ ok: true, id: args.id, status: 'cancelled' }));
    return 0;
  }
  if (command === 'list') {
    const ledger = loadLedger(home, deps);
    out(JSON.stringify(ledger, null, 2));
    return 0;
  }
  if (command === 'tick') {
    const result = await tick(home, {
      now: args.now ? new Date(args.now) : new Date(),
      dryRun: !!args.dryRun,
      notify: deps.notify || defaultNotify,
      load: (h) => loadLedger(h, deps),
      save: (h, ledger) => saveLedger(h, ledger, deps),
    });
    out(JSON.stringify(result, null, 2));
    return 0;
  }
  throw new Error(`不明なコマンド: ${command}`);
}

export async function defaultNotify({ home, message }) {
  const { addItem } = await import('./kim-inbox.mjs');
  const { appendMobilePush } = await import('./lib/mobile-push-queue.mjs');
  const { resolveOwner } = await import('./fleet-owner.mjs');
  const text = `${message.title}\n${message.body}`;
  await addItem(home, {
    kind: 'info',
    urgent: true,
    source: 'schedule-push',
    dedupeKey: `schedule-push:${message.title}:${message.body}`.slice(0, 180),
    text,
  });
  const owner = resolveOwner({ home });
  appendMobilePush(home, { owner, title: message.title, body: message.body });
}

if (isEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
