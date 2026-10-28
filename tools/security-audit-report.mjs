#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEMS, summarizeAudit, auditDate } from './security-audit-readonly.mjs';
import { isEntry } from './is-entry.mjs';

export function buildMatrix(results, expectedLabels = []) {
  const latest = new Map();
  for (const entry of results) {
    const audit = entry.audit || entry;
    const label = entry.label || audit.host;
    if (!label || !Number.isFinite(Date.parse(audit.at))) continue;
    if (!latest.has(label) || Date.parse(audit.at) >= Date.parse(latest.get(label).at)) latest.set(label, audit);
  }
  const labels = [...new Set([...expectedLabels, ...latest.keys()])].sort();
  const missing = labels.filter(label => !latest.has(label));
  const summaries = new Map([...latest].map(([label, a]) => [label, a.truncated && a.summary ? a.summary : summarizeAudit(a)]));
  const rows = ITEMS.map(item => ({ item, cells: Object.fromEntries(labels.map(label => {
    if (!summaries.has(label)) return [label, { level: 'missing', detail: '未回収' }];
    const s = summaries.get(label);
    for (const level of ['red','yellow','green']) {
      const found = s[level]?.find(e => e.item === item);
      if (found) return [label, { level, detail: String(found.detail).slice(0, 120) }];
    }
    return [label, { level: 'yellow', detail: '未取得' }];
  })) }));
  return { labels, rows, missing };
}
export function parseAuditMail(text, date) {
  const header = /^<!-- security-audit: v1 label=([^\s<>]+) date=(\d{8}) -->\r?\n/.exec(text);
  if (!header || header[2] !== date) return null;
  const block = /```json\s*\r?\n([\s\S]*?)\r?\n```/.exec(text.slice(header[0].length));
  if (!block) throw new Error('audit mail JSON fence missing');
  const audit = JSON.parse(block[1]);
  if (audit.schemaVersion !== 1) throw new Error('unsupported audit schema');
  return { label: header[1], audit };
}
const cell = s => String(s).replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '');
export function renderMatrix(matrix) {
  const icon = { red: '🔴', yellow: '🟡', green: '🟢', missing: '未回収' };
  return [`| 項目 | ${matrix.labels.map(cell).join(' | ')} |`, `| --- | ${matrix.labels.map(() => '---').join(' | ')} |`, ...matrix.rows.map(row => `| ${row.item} | ${matrix.labels.map(label => { const c=row.cells[label]; return `${icon[c.level]} ${cell(c.detail)}`; }).join(' | ')} |`)].join('\n') + '\n';
}
function main(args) {
  let date = auditDate(), inbox, out;
  for (let i=0; i<args.length; i++) {
    const flag=args[i];
    if (!['--date','--inbox','--out'].includes(flag) || !args[i+1]) throw new Error('unknown option or missing value');
    const value=args[++i];
    if (flag==='--date') date=value;
    if (flag==='--inbox') inbox=value;
    if (flag==='--out') out=value;
  }
  if (!/^\d{8}$/.test(date)) throw new Error('date must be yyyyMMdd');
  const home=process.env.USERPROFILE || os.homedir();
  inbox ||= path.join(home,'.claude','fleet-inbox');
  const results=[];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile() && /\.(md|json)$/.test(e.name)) {
        try {
          // 現行 fleet-mail の inbox は JSON 封筒なので md と両方を受け入れる。
          const raw=fs.readFileSync(file,'utf8');
          const text=e.name.endsWith('.json') ? JSON.parse(raw).body : raw;
          if (typeof text !== 'string') continue;
          const record=parseAuditMail(text,date);
          if (record) results.push(record);
        } catch { console.error(`audit inbox invalid: ${e.name}`); }
      }
    }
  };
  walk(inbox);
  const local=path.join(home,'.claude','security-audit',date);
  if (fs.existsSync(local)) for (const name of fs.readdirSync(local).filter(n=>n.endsWith('.json'))) {
    try { const audit=JSON.parse(fs.readFileSync(path.join(local,name),'utf8')); if (audit.schemaVersion===1) results.push(audit); }
    catch { console.error(`local audit invalid: ${name}`); }
  }
  const dir=path.dirname(fileURLToPath(import.meta.url));
  const mapFile=[path.join(dir,'fleet-pc-map.json'),path.join(dir,'..','fleet-pc-map.json')].find(f=>fs.existsSync(f));
  const expected=mapFile ? Object.keys(JSON.parse(fs.readFileSync(mapFile,'utf8'))).filter(k=>!k.startsWith('_')) : [];
  const markdown=renderMatrix(buildMatrix(results,expected));
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true}); fs.writeFileSync(out,markdown); }
  console.log(markdown);
}
if (isEntry(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode=1; }
}
