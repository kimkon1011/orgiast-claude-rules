import fs from 'node:fs';
import path from 'node:path';

export const deferredPath = home => path.join(home, '.claude', 'discord-notify-deferred.jsonl');

function parseDeferred(raw, now, keepMs) {
  const entries = [];
  let dropped = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!Number.isFinite(value?.at) || typeof value?.text !== 'string' || !value.text.trim() || now - value.at > keepMs) dropped++;
      else entries.push({ at: value.at, text: value.text });
    } catch { dropped++; }
  }
  return { entries, dropped };
}

export function readDeferred(home, { now = Date.now(), keepMs = 7 * 24 * 3600 * 1000 } = {}) {
  try { return parseDeferred(fs.readFileSync(deferredPath(home), 'utf8'), now, keepMs).entries; }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

export function drainDeferred(home, { now = Date.now(), keepMs = 7 * 24 * 3600 * 1000 } = {}) {
  const file = deferredPath(home);
  const draining = `${file}.draining-${process.pid}-${Date.now()}`;
  try { fs.renameSync(file, draining); }
  catch (error) { if (error?.code === 'ENOENT') return { entries: [], dropped: 0 }; throw error; }
  try { return parseDeferred(fs.readFileSync(draining, 'utf8'), now, keepMs); }
  finally { fs.rmSync(draining, { force: true }); }
}

// 送信に失敗した回の取りこぼしを防ぐため、消費した分をそのまま戻せるようにする。
export function appendDeferred(home, entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(entry => Number.isFinite(entry?.at) && typeof entry?.text === 'string');
  if (!list.length) return 0;
  const file = deferredPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${list.map(entry => JSON.stringify({ at: entry.at, text: entry.text })).join('\n')}\n`, 'utf8');
  return list.length;
}

const formatter = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const stamp = at => formatter.format(new Date(at)).replace(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/, '$1/$2 $3:$4');

export function formatDeferredSection(entries, { maxItems = 5, maxChars = 900 } = {}) {
  if (!Array.isArray(entries) || !entries.length || maxChars <= 0) return '';
  const selected = entries.slice(-Math.max(0, maxItems)).reverse();
  const omitted = Math.max(0, entries.length - selected.length);
  const header = '【通知が混んでいて保留していたもの】';
  const suffix = omitted ? `…他${omitted}件` : '';
  const items = selected.map(entry => ({ prefix: `・${stamp(entry.at)} `, text: String(entry.text).replace(/\s+/g, ' ').trim(), cut: false }));
  const render = () => [header, ...items.map(item => `${item.prefix}${item.text}${item.cut ? '…' : ''}`), suffix].filter(Boolean).join('\n');
  let output = render();
  while (output.length > maxChars && items.some(item => item.text.length)) {
    const item = items.reduce((longest, current) => current.text.length > longest.text.length ? current : longest, items[0]);
    const overflow = output.length - maxChars;
    item.text = item.text.slice(0, Math.max(0, item.text.length - overflow - (item.cut ? 0 : 1)));
    item.cut = true;
    output = render();
  }
  return output.length <= maxChars ? output : output.slice(0, maxChars);
}
