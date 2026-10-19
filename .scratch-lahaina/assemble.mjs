import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
const dir = 'C:/Users/uers/.claude/fleet-inbox/';
const ids = ['mail-20261014162901701-1912','mail-20261014162922353-8120','mail-20261014162931522-3253','mail-20261014162938487-4663'];
const parts = {};
for (const id of ids) {
  const j = JSON.parse(fs.readFileSync(dir + id + '.json', 'utf8'));
  const body = j.body || j.text || JSON.stringify(j);
  const m = body.match(/分割\s*(\d)\s*of\s*(\d)\s*[）)]?\s*\n([A-Za-z0-9+/=\s]+)/);
  console.log(id, 'keys=', Object.keys(j).join(','), 'part=', m && m[1], 'len=', m && m[3].replace(/\s/g,'').length);
  if (m) parts[m[1]] = parts[m[1]] || m[3].replace(/\s/g, '');
}
if (!parts[1] || !parts[2] || !parts[3]) { console.log('missing parts', Object.keys(parts)); process.exit(1); }
const buf = zlib.gunzipSync(Buffer.from(parts[1] + parts[2] + parts[3], 'base64'));
fs.writeFileSync('C:/Users/uers/.claude/nightly-repo/.scratch-lahaina/lahaina-docs.patch', buf);
console.log('sha256', crypto.createHash('sha256').update(buf).digest('hex'));
