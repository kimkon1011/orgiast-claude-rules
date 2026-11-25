#!/usr/bin/env node
// Trusted source seat only. RAW Sheets values prevent message formula execution.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';
export const COLUMNS = ['id','ts','source','chat','sender','text','receivedAt'];
const digest = value => createHash('sha256').update(value).digest('hex');
export function collectLineRows(home = os.homedir()) {
  const rows = new Map();
  for (const kind of ['line-openchat','line-oa']) {
    const dir = path.join(home,'.claude',kind);
    let files; try { files = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const file of files.filter(x => kind === 'line-openchat' ? /^\d{4}-\d{2}\.jsonl$/.test(x) : /^events-\d{4}-\d{2}\.jsonl$/.test(x)).sort()) {
      for (const line of fs.readFileSync(path.join(dir,file),'utf8').split(/\r?\n/).filter(Boolean)) {
        const r = JSON.parse(line), oa = kind === 'line-oa';
        if (oa && (r.type !== 'message' || r.message?.type !== 'text')) continue;
        const text = oa ? r.message.text : r.text;
        if (typeof text !== 'string' || !text.trim()) continue;
        const ts = Number(oa ? r.timestamp : r.ts);
        if (!Number.isFinite(ts)) throw Error(`Invalid LINE timestamp: ${file}`);
        const id = `${kind}:${r.id || r.webhookEventId || r.message?.id || digest(line)}`;
        rows.set(id, [id, String(ts), kind, String(oa ? r.source?.groupId || r.source?.userId || '' : r.chat || ''),
          String(oa ? r.source?.userId || '' : r.sender || ''), text, String(r.receivedAt || '')]);
      }
    }
  }
  return [...rows.values()].sort((a,b) => Number(a[1])-Number(b[1]) || a[0].localeCompare(b[0]));
}
export async function syncLineHistory({ home = os.homedir(), config, fetchImpl = fetch, getToken = getDriveToken, dryRun = false } = {}) {
  config ??= JSON.parse(fs.readFileSync(path.join(home,'.claude','line-history-sync.json'),'utf8'));
  if (!/^[\w-]+$/.test(config.sheetId || '')) throw Error('LINE sheet configuration missing');
  const rows = collectLineRows(home);
  const token = await getToken({ impersonate: 'kim@orgiast.jp', scope: 'https://www.googleapis.com/auth/spreadsheets' });
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${config.sheetId}/values`;
  const call = async (url, options = {}) => {
    for (let attempt=0; ; attempt++) {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' } });
      // Retry only explicit quota rejection. Never retry an ambiguous append.
      if(response.status===429 && attempt<4){await response.body?.cancel();await new Promise(r=>setTimeout(r,15000));continue;}
      if (!response.ok) throw Error(`LINE Sheets HTTP ${response.status}`); return response.json();
    }
  };
  const current = await call(`${base}/Messages!A:A`), existing = new Set((current.values || []).map(r => r[0]));
  const pending = rows.filter(r => !existing.has(r[0]));
  if (!dryRun) {
    for (let i=0; i<pending.length; i+=2000) await call(`${base}/Messages!A:G:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method:'POST', body:JSON.stringify({ values:pending.slice(i,i+2000) }) });
    let contacts = { users:[], groups:[] };
    try { contacts = JSON.parse(fs.readFileSync(path.join(home,'.claude','line-oa','contacts.json'),'utf8')); } catch (e) { if(e.code !== 'ENOENT') throw e; }
    const contactRows = [...contacts.users.map(c => [c.userId,c.displayName || '',c.followed !== false ? 'active':'inactive']),
      ...contacts.groups.map(c => [c.groupId,c.groupName || '',c.joined !== false ? 'active':'inactive'])];
    // A single batch update replaces the small contact table and successful-sync marker.
    // Reader uses the stored count, so stale rows after shrink cannot be selected.
    await call(`${base}:batchUpdate`, { method:'POST', body:JSON.stringify({ valueInputOption:'RAW', data:[
      { range:'Contacts!A1:C1', values:[['id','name','state']] },
      ...(contactRows.length ? [{ range:`Contacts!A2:C${contactRows.length+1}`, values:contactRows }] : []),
      { range:'Status!A1:B3', values:[['syncedAt',new Date().toISOString()],['contacts',String(contactRows.length)],['messages',String(Math.max(0,(current.values || []).length-1)+pending.length)]] },
    ] }) });
  }
  return { dryRun, sourceRows: rows.length, appended: dryRun ? 0 : pending.length, pending: pending.length, sheetId: config.sheetId };
}
if (isEntry(import.meta.url)) syncLineHistory({ dryRun: process.argv.includes('--dry-run') }).then(x=>console.log(JSON.stringify(x))).catch(e=>{ console.error(e.message); process.exitCode=1; });
