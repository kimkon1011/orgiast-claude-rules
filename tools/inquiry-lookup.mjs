#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDriveToken } from './lib/drive-auth.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { searchGmail } from './gmail-search.mjs';
import { routeMailbox } from './lib/mail-groups.mjs';
import { INQUIRY_SHEET, CASES_SHEET, INQUIRY_TAB, readSheet, searchRows, normalize, dateISO } from './lib/inquiry-sheet.mjs';
import { isEntry } from './is-entry.mjs';
const DAY = 86400000;
export function gmailQuery(terms) {
  return `{${terms.map(t => `"${t.replace(/["\\\r\n]/g, ' ')}"`).join(' ')}} newer_than:90d`;
}
export async function lookup(terms, { user, now = Date.now(), home = process.env.ORGIAST_HOME || os.homedir(), getToken = getDriveToken, fetchImpl = gwsFetch, sheetReader = readSheet, gmailSearch = searchGmail } = {}) {
  if (!terms.length || terms.some(t => !String(t).trim())) throw Error('検索語を指定してください');
  const notices = [], sources = {}, hits = [], auth = { getToken, fetchImpl, signal: AbortSignal.timeout(120000) };
  const json = async (scope, url, impersonate) => {
    const token = await getToken({ scope: `https://www.googleapis.com/auth/${scope}`, ...(impersonate ? { impersonate } : {}), signal: auth.signal });
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: auth.signal });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    return r.json();
  };
  const allPages = async (scope, url, key, impersonate) => {
    const rows = []; let pageToken;
    do { const u = new URL(url); if (pageToken) u.searchParams.set('pageToken', pageToken);
      const data = await json(scope, u.href, impersonate); rows.push(...(data[key] || [])); pageToken = data.nextPageToken;
    } while (pageToken);
    return rows;
  };
  const collect = async (source, fn) => {
    try { const result = await fn(); hits.push(...result); sources[source] = { status: '確認済み', count: result.length, checkedAt: new Date(now).toISOString() }; }
    catch (e) { sources[source] = { status: '未確認', reason: e.message }; }
  };
  const mailboxes = [...new Set(['seisaku-team@orgiast.jp', 'kim@orgiast.jp', ...(user ? [routeMailbox(user).user] : [])])];
  await Promise.allSettled([
    ...[[INQUIRY_SHEET, INQUIRY_TAB, 'inquiry-sheet'], [CASES_SHEET, '案件一覧', 'cases-sheet']].map(([id, tab, source]) => collect(source, async () => searchRows(await sheetReader(id, tab, auth), terms, { sheetId: id, tab }))),
    ...mailboxes.map(mailbox => collect(`gmail:${mailbox}`, async () => {
      const routed = routeMailbox(user || mailbox, gmailQuery(terms));
      const query = user && routed.notice && mailbox === routed.user ? routed.query : gmailQuery(terms);
      if (user && routed.notice && mailbox === routed.user) notices.push(routed.notice);
      const result = []; let pageToken;
      do {
        const page = await gmailSearch({ ...auth, user: mailbox, query, max: 100, pageToken, concurrency: 5 });
        result.push(...page.messages.map(m => ({ source: `gmail:${mailbox}`, date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : dateISO(m.date), title: m.subject, excerpt: m.snippet,
          from: m.from, to: m.to, url: `https://mail.google.com/mail/u/${encodeURIComponent(mailbox)}/#all/${m.threadId}` })));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return result;
    })),
    collect('hub-index', async () => {
      let rootId;
      try { rootId = JSON.parse(fs.readFileSync(path.join(home, '.claude/comms-hub/state.json'), 'utf8')).rootId; } catch (e) { if (e.code !== 'ENOENT') notices.push(`ハブstateを再検索: ${e.message}`); }
      const files = q => allPages('drive', `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q: `${q} and trashed=false`, fields: 'nextPageToken,files(id,name,webViewLink,modifiedTime)', pageSize: '100' })}`, 'files');
      if (!rootId) {
        const roots = await files("name='案件情報ハブ' and mimeType='application/vnd.google-apps.folder'");
        if (roots.length !== 1) throw Error(`案件情報ハブの候補 ${roots.length} 件: ルートを特定できません`);
        rootId = roots[0].id;
      }
      if (!/^[\w-]+$/.test(rootId)) throw Error('Invalid hub rootId');
      const indexes = await files(`'${rootId}' in parents and name='index.json'`);
      if (indexes.length !== 1) throw Error(`index.json の候補 ${indexes.length} 件`);
      const index = await json('drive', `https://www.googleapis.com/drive/v3/files/${indexes[0].id}?alt=media`);
      for (const [source, state] of Object.entries(index.sources || {})) notices.push(`ハブ ${source}: lastSuccess=${state.lastSuccess || '未確認'}${state.error ? ` / ${state.error}` : ''}`);
      return Object.entries(index.cases || {}).filter(([id, c]) => terms.some(t => normalize(JSON.stringify([id, c])).includes(normalize(t)))).map(([id, c]) => ({ source: 'hub-index', date: c.updatedAt || indexes[0].modifiedTime || null, title: `${id} ${c.name || ''}`, excerpt: JSON.stringify(c), url: c.url || (c.docId ? `https://docs.google.com/document/d/${c.docId}/edit` : `https://drive.google.com/open?id=${indexes[0].id}`) }));
    }),
    collect('calendar:kim@orgiast.jp', async () => {
      const params = new URLSearchParams({ timeMin: new Date(now - 30 * DAY).toISOString(), timeMax: new Date(now + 30 * DAY).toISOString(), singleEvents: 'true', maxResults: '2500' });
      const events = await allPages('calendar.readonly', `https://www.googleapis.com/calendar/v3/calendars/kim%40orgiast.jp/events?${params}`, 'items', 'kim@orgiast.jp');
      return events.filter(e => terms.some(t => normalize([e.summary, e.description, e.location, JSON.stringify(e.attendees)].join('\n')).includes(normalize(t)))).map(e => ({ source: 'calendar:kim@orgiast.jp', date: e.start?.dateTime || e.start?.date || null, title: e.summary, excerpt: [e.description, e.location].filter(Boolean).join('\n'), url: e.htmlLink }));
    }),
  ]);
  hits.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0) || a.source.localeCompare(b.source));
  return { terms, generatedAt: new Date(now).toISOString(), complete: Object.values(sources).every(s => s.status === '確認済み'), sources, notices, hits };
}
export function markdown(result) {
  const output = [`# 問い合わせ横断検索: ${result.terms.join(' / ')}`, '', ...Object.entries(result.sources).map(([name, s]) => `- ${name}: ${s.status}${s.reason ? `（${s.reason}）` : ` / ${s.count}件`}`), ...result.notices.map(n => `- ${n}`), ''];
  if (!result.hits.length) output.push(result.complete ? '確認済みの検索範囲で該当0件。' : '取得できた範囲で該当0件。未確認の情報源があるため「見つからない」とは断定できません。');
  for (const hit of result.hits) {
    output.push(`## ${hit.date || '日時不明'} | ${hit.source} | ${hit.title}`, '', `[元の情報${hit.row ? `（${hit.row}行目）` : ''}](${hit.url})`, '', hit.excerpt || '(抜粋なし)', '');
    if (hit.columns) for (const c of hit.columns) output.push(`- ${c.column} ${c.name}: ${String(c.value).replace(/\n/g, '\n  ')}`);
    output.push('');
  }
  return output.join('\n');
}
export function parseArgs(args) {
  const terms = []; let user, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--user') { user = args[++i]; if (!user || user.startsWith('--')) throw Error('--user にアドレスが必要です'); }
    else if (args[i].startsWith('--')) throw Error(`不明な引数: ${args[i]}`);
    else terms.push(args[i]);
  }
  if (!terms.length) throw Error('使い方: node tools/inquiry-lookup.mjs <検索語...> [--json] [--user <address>]');
  return { terms, user, json };
}
if (isEntry(import.meta.url)) {
  try { const args = parseArgs(process.argv.slice(2)); const result = await lookup(args.terms, { user: args.user }); console.log(args.json ? JSON.stringify(result, null, 2) : markdown(result)); if (!result.complete) process.exitCode = 2; }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
