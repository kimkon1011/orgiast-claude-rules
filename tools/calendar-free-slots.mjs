#!/usr/bin/env node
// 決定的に空き枠を計算するCLI。LLM不要。
// GoogleカレンダーAPI v3 からイベントを取得し、SKILL.md のルールに従って空き時間を算出。
// --fixture <file> で API を呼ばずテスト・オフライン利用可能。
// 内部時間はすべてエポックミリ秒。JST固定。

import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const JST = 9 * HOUR_MS;
const REGION_NAMES = ['東京', '浜松', '福岡', '名古屋', '沖縄', '横浜', '京都', '神戸', '札幌', '仙台', '広島', '博多', '金沢'];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const HOLIDAY_WORDS = ['休', '休暇', '有給', 'OFF'];

// JST日付変換: エポックミリ秒 ↔ JST日付文字列
function jstMidnight(ymdOrDate) {
  if (typeof ymdOrDate === 'string') {
    const [y, m, d] = ymdOrDate.split('-').map(Number);
    return Date.UTC(y, m - 1, d) - JST;
  }
  // Date object -> JST 00:00:00 of its JST date
  const s = ymdOrDate.toISOString().slice(0, 10);
  return jstMidnight(s);
}

function ymdJST(ms) {
  const d = new Date(ms + JST);
  return d.toISOString().slice(0, 10);
}

function dowJST(ms) {
  return new Date(ms + JST).getDay();
}

function fmtTimeJST(ms, dayStartMs) {
  const diff = ms - dayStartMs;
  const totalMin = Math.round(diff / 60000);
  return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
}

function jpDay(dow) { return WEEKDAYS[dow]; }

// === イベント解析 ===

function parseEventTime(item) {
  if (item.start?.dateTime) {
    // "2026-11-10T12:00:00+09:00"
    return { start: Date.parse(item.start.dateTime), end: Date.parse(item.end.dateTime), allDay: false };
  }
  // all-day "2026-11-10" -> JST midnight
  const s = jstMidnight(item.start.date);
  const e = item.end?.date ? jstMidnight(item.end.date) : s + DAY_MS;
  return { start: s, end: e, allDay: true };
}

function isAdjustable(s) { return s.includes('【調整可】') || s.includes('【調節可】'); }
function isGBuf(s) {
  const t = s.replace(/\s/g, '');
  return t.startsWith('G:') || t.startsWith('G：');
}
function isDeclined(item) { return item.attendees?.some(a => a.self && a.responseStatus === 'declined') ?? false; }
function isTransparent(item) { return item.transparency === 'transparent'; }

function isBlockedEvent(item) {
  if (isDeclined(item)) return false;
  if (isTransparent(item)) return false;
  if (isAdjustable(item.summary || '')) return false;
  return true;
}

function detectRegion(s) {
  if (!s) return null;
  for (const r of REGION_NAMES) { if (s.includes(r)) return r; }
  return null;
}

function isHolidayStr(s) { return HOLIDAY_WORDS.some(w => (s || '').includes(w)); }
function isRegionOnly(s) { return REGION_NAMES.some(r => (s || '').trim() === r); }

function dedupByKey(items) {
  const seen = new Set();
  return items.filter(item => {
    const t = parseEventTime(item);
    const k = `${t.start}|${t.end}|${item.summary}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function mergeIntervals(ivs) {
  if (!ivs.length) return [];
  const s = [...ivs].sort((a, b) => a[0] - b[0]);
  const m = [];
  for (const [st, en] of s) {
    if (m.length && st <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], en);
    else m.push([st, en]);
  }
  return m;
}

// === カレンダーAPI ===

async function fetchCalendar(token, email, from, to) {
  const items = [];
  let pageToken;
  const params = new URLSearchParams({
    timeMin: new Date(jstMidnight(from)).toISOString(),
    timeMax: new Date(jstMidnight(to) + DAY_MS).toISOString(),
    singleEvents: 'true', orderBy: 'startTime',
    timeZone: 'Asia/Tokyo', maxResults: '250',
  });
  do {
    if (pageToken) params.set('pageToken', pageToken);
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`${email}: HTTP ${res.status}`);
    const data = await res.json();
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken && items.length < 5000);
  return items;
}

// === メイン ===

export async function runCalendarFreeSlots(options, deps = {}) {
  const { from, to, mode, region, start, end, min, calendars, json, fixture, weekends } = options;
  const warn = deps.warn || console.error;
  const fromMs = jstMidnight(from);
  const toMs = jstMidnight(to) + DAY_MS;
  // API取得範囲を拡張: 前日・翌日の終日予定も取得
  const fetchFrom = ymdJST(fromMs - DAY_MS);
  const fetchTo = ymdJST(toMs);

  // イベント取得
  let rawItems = [];
  const sourceCounts = {};
  if (fixture) {
    const parsed = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    if (Array.isArray(parsed)) rawItems = parsed;
    else { rawItems = parsed.events || []; Object.assign(sourceCounts, parsed.sourceCounts || {}); }
  } else {
    for (const email of calendars) {
      const token = deps.token || await getDriveToken({ impersonate: email, scope: CALENDAR_SCOPE, signal: deps.signal });
      const events = await fetchCalendar(token, email, fetchFrom, fetchTo);
      sourceCounts[email] = events.length;
      for (const e of events) { e._source = email; }
      rawItems.push(...events);
    }
    if (Object.keys(sourceCounts).length < calendars.length) {
      throw new Error('カレンダー取得失敗: 片方しか取得できませんでした');
    }
  }

  // 全日/時間指定に分離
  const allDayItems = rawItems.filter(e => Boolean(e.start?.date));
  const timedItems = rawItems.filter(e => Boolean(e.start?.dateTime));

  // kim の全日だけ地域・休暇判定に使う
  const kimAllDay = allDayItems.filter(e => (e._source || '').includes('kim'));

  // 時限制イベントからブロック区間
  const dedupedTimed = dedupByKey(timedItems);
  const blockingIntervals = dedupedTimed.filter(isBlockedEvent).map(item => {
    const t = parseEventTime(item);
    if (isGBuf(item.summary || '')) return [t.start - HOUR_MS, t.end + HOUR_MS];
    return [t.start, t.end];
  });
  const mergedBlocks = mergeIntervals(blockingIntervals);

  // 地域外の日のバッファ日付: 対象地域と異なる地域日付の前後1日を候補から外す
  const nonRegionBufferSet = new Set();
  for (const item of kimAllDay) {
    const t = parseEventTime(item);
    const title = (item.summary || '').trim();
    const r = detectRegion(title);
    if (!r || r === region) continue; // 対象地域と同じか地域なしならバッファ不要
    // 複数日終日: 全日程の前後1日をバッファ
    for (let d2 = t.start; d2 < t.end; d2 += DAY_MS) {
      for (const off of [-DAY_MS, DAY_MS]) {
        const ts = d2 + off;
        if (ts >= fromMs && ts < toMs) nonRegionBufferSet.add(ymdJST(ts));
      }
    }
  }

  // 日ごと計算
  const daySlots = [];
  const startMs = toMS(start);
  const endMs = toMS(end);
  const minMs = min * 60000;

  for (let d = fromMs; d < toMs; d += DAY_MS) {
    const key = ymdJST(d);
    const dow = dowJST(d);

    // 地域・休暇判定
    let curRegion = '大阪';
    let isHoliday = false;
    for (const item of kimAllDay) {
      const t = parseEventTime(item);
      if (d >= t.end || d + DAY_MS <= t.start) continue;
      const title = (item.summary || '').trim();
      const r = detectRegion(title);
      if (r) curRegion = r;
      if (!isRegionOnly(title) && isHolidayStr(title)) isHoliday = true;
    }

    // フィルタ
    if (!weekends && (dow === 0 || dow === 6)) continue;
    if (isHoliday) continue;
    if (mode === 'offline' && curRegion !== region) continue;
    if (mode === 'offline' && nonRegionBufferSet.has(key)) continue;

    const dayStart = d + startMs;
    const dayEnd = d + endMs;

    const dayBlocks = mergedBlocks.filter(([bs, be]) => bs < dayEnd && be > dayStart);
    let cursor = dayStart;
    const free = [];

    for (const [bs, be] of dayBlocks) {
      const bs2 = Math.max(cursor, bs);
      const be2 = Math.min(dayEnd, be);
      if (bs2 > cursor && (bs2 - cursor) >= minMs) free.push([cursor, bs2]);
      cursor = Math.max(cursor, be2);
    }
    if (dayEnd > cursor && (dayEnd - cursor) >= minMs) free.push([cursor, dayEnd]);

    daySlots.push({ date: key, weekday: jpDay(dow), region: curRegion, free, _dayStart: d });
  }

  // 出力
  if (json) {
    return {
      generatedAt: new Date().toISOString(),
      mode, region: mode === 'online' ? null : region,
      days: daySlots.filter(d => d.free.length).map(d => ({
        date: d.date, weekday: d.weekday, region: d.region,
        slots: d.free.map(f => ({ start: fmtTimeJST(f[0], d._dayStart), end: fmtTimeJST(f[1], d._dayStart) })),
      })),
      sources: sourceCounts, warnings: [],
    };
  }

  const lines = [mode === 'offline' ? `オフライン（${region}）の候補:` : 'オンライン候補:'];
  let hasSlots = false;
  for (const day of daySlots) {
    if (!day.free.length) continue;
    hasSlots = true;
    const month = parseInt(day.date.slice(5, 7));
    const dayNum = parseInt(day.date.slice(8, 10));
    const dateStr = `${month}月${dayNum}日`;
    const ranges = day.free.map(f => `${fmtTimeJST(f[0], day._dayStart)}〜${fmtTimeJST(f[1], day._dayStart)}`);
    lines.push(`${dateStr}(${day.weekday}) ${ranges.join('、')}　※${day.region}`);
  }
  if (!hasSlots) lines.push('（該当する空き時間なし）');
  return lines.join('\n');
}

function toMS(s) {
  const [h, m] = s.split(':').map(Number);
  return (h * 60 + m) * 60000;
}

export function parseArgs(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const now = new Date();
  const nowJST = jstMidnight(ymdJST(now.getTime()));
  const from = get('--from') || ymdJST(now.getTime());
  let to = get('--to');
  if (!to) {
    const d = nowJST + 6 * DAY_MS;
    to = ymdJST(d);
  }
  return {
    from, to, mode: get('--mode') || 'online', region: get('--region') || '大阪',
    start: get('--start') || '09:00', end: get('--end') || '18:00',
    slot: Number(get('--slot') || 30), min: Number(get('--min') || 30),
    calendars: (get('--calendars') || 'kim@orgiast.jp,seisaku-team@orgiast.jp').split(','),
    json: argv.includes('--json'), fixture: get('--fixture'), weekends: argv.includes('--weekends'),
  };
}

if (isEntry(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = await runCalendarFreeSlots(opts);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}