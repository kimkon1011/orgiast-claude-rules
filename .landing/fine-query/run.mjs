// 読み取り専用: ファイン11月案件照会 (mail-1792425557745-15b1ea97)
import { getDriveToken } from '../../tools/lib/drive-auth.mjs';
import { extractBody, headerValue } from '../../tools/gmail-search.mjs';
import { writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const USER = 'seisaku-team@orgiast.jp';
const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const D = 'https://www.googleapis.com/drive/v3';
const out = {};

async function get(token, url, raw = false) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}
function attachments(payload) {
  const res = [];
  const walk = (n) => { if (!n) return; if (n.filename) res.push({ name: n.filename, id: n.body?.attachmentId, mime: n.mimeType }); (n.parts || []).forEach(walk); };
  walk(payload);
  return res;
}
function pptxText(buf, tag) {
  const dir = join(OUT, 'x', tag.replace(/[^\w.-]/g, '_'));
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const f = join(dir, 'f.zip'); writeFileSync(f, buf);
  execFileSync('tar', ['-xf', f, '-C', dir]);
  const sd = join(dir, 'ppt', 'slides');
  const files = readdirSync(sd).filter((n) => /^slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
  return files.map((n) => {
    const xml = readFileSync(join(sd, n), 'utf8');
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).filter(Boolean);
    return `[${n.replace('.xml', '')}] ${paras.join(' / ')}`;
  }).join('\n');
}

// 1) Gmail
const pptxDone = [];
try {
  const gt = await getDriveToken({ scope: 'https://www.googleapis.com/auth/gmail.readonly', impersonate: USER });
  const q = '(from:fine-steel.co.jp OR ファインスティール) newer_than:30d';
  const list = await get(gt, `${G}/messages?q=${encodeURIComponent(q)}&maxResults=30`);
  out.gmailEstimate = list.resultSizeEstimate;
  out.mails = [];
  for (const s of list.messages || []) {
    const m = await get(gt, `${G}/messages/${s.id}?format=full`);
    const att = attachments(m.payload);
    out.mails.push({ id: m.id, internalDate: new Date(Number(m.internalDate)).toISOString(), date: headerValue(m.payload, 'date'), from: headerValue(m.payload, 'from'), to: headerValue(m.payload, 'to'), subject: headerValue(m.payload, 'subject'), attachments: att.map((a) => a.name), body: extractBody(m.payload, 300).replace(/\s+/g, ' ') });
    for (const a of att) {
      if (/\.pptx$/i.test(a.name) && a.id) {
        try {
          const j = await get(gt, `${G}/messages/${m.id}/attachments/${a.id}`);
          pptxDone.push({ src: `gmail:${m.id}`, name: a.name, text: pptxText(Buffer.from(j.data, 'base64url'), `g_${m.id}_${a.name}`) });
        } catch (e) { pptxDone.push({ src: `gmail:${m.id}`, name: a.name, error: String(e.message) }); }
      }
    }
  }
} catch (e) { out.gmailError = String(e.message); }

// 2) Drive
try {
  const dt = await getDriveToken({ scope: 'https://www.googleapis.com/auth/drive.readonly', impersonate: USER });
  const fields = 'files(id,name,mimeType,modifiedTime,owners(emailAddress))';
  const common = 'supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=100';
  try {
    const r = await get(dt, `${D}/files?q=${encodeURIComponent("'1OABrU5JqeF1T5FPG_F9j-DiC_tvhf7Ou' in parents and trashed=false")}&orderBy=modifiedTime desc&fields=${fields}&${common}`);
    out.folder = r.files;
  } catch (e) { out.folderError = String(e.message); }
  for (const [k, qq] of [['s261125FIN', "name contains '261125FIN' and trashed=false"], ['sMoushikomi', "name contains '申込' and trashed=false and modifiedTime > '2026-09-22T00:00:00Z'"]]) {
    try { out[k] = (await get(dt, `${D}/files?q=${encodeURIComponent(qq)}&orderBy=modifiedTime desc&fields=${fields}&${common}`)).files; } catch (e) { out[k + 'Error'] = String(e.message); }
  }
  // サブフォルダも1階層見る
  out.sub = {};
  for (const f of (out.folder || []).filter((f) => f.mimeType === 'application/vnd.google-apps.folder')) {
    try { out.sub[f.name] = (await get(dt, `${D}/files?q=${encodeURIComponent(`'${f.id}' in parents and trashed=false`)}&orderBy=modifiedTime desc&fields=${fields}&${common}`)).files; } catch (e) { out.sub[f.name] = String(e.message); }
  }
  if (!pptxDone.length) {
    const all = [...(out.folder || []), ...Object.values(out.sub).flat()].filter((f) => f && /\.pptx$/i.test(f.name || ''));
    for (const f of all) {
      try { pptxDone.push({ src: `drive:${f.id}`, name: f.name, text: pptxText(await get(dt, `${D}/files/${f.id}?alt=media&supportsAllDrives=true`, true), `d_${f.id}`) }); } catch (e) { pptxDone.push({ src: `drive:${f.id}`, name: f.name, error: String(e.message) }); }
    }
  }
} catch (e) { out.driveError = String(e.message); }

out.pptx = pptxDone;
writeFileSync(join(OUT, 'result.json'), JSON.stringify(out, null, 2));
console.log(`mails=${out.mails?.length ?? 'ERR'} folder=${out.folder?.length ?? 'ERR'} pptx=${pptxDone.length} gmailErr=${out.gmailError || ''} folderErr=${out.folderError || ''}`);
