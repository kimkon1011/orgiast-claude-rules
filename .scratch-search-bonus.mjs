import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.homedir(), '.claude', 'projects');
const extraRoots = [path.join(os.homedir(), '.claude', 'shared-memory')];
const files = [];
function walk(d) {
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl') || (e.name.endsWith('.md') && p.includes('memory'))) files.push(p);
  }
}
walk(root);
for (const r of extraRoots) walk(r);

const pctRe = /120\s*[%％]|120パーセント/;
const bonusRe = /賞与|ボーナス|人事評価/;
const overRe = /超過分|超えた分|上回った分/;
const selfRe = /mail-1793238551765|過去セッションログの検索/;
let jsonl = 0, md = 0;
const hits = [];
for (const f of files) {
  if (f.endsWith('.jsonl')) jsonl++; else md++;
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!bonusRe.test(txt)) continue;
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (selfRe.test(l)) continue;
    const a = pctRe.test(l) && bonusRe.test(l);
    const b = overRe.test(l) && /賞与|ボーナス/.test(l);
    if (!a && !b) continue;
    let ts = '';
    const m = l.match(/"timestamp":"([^"]+)"/);
    if (m) ts = m[1];
    const idx = l.search(pctRe) >= 0 ? l.search(pctRe) : l.search(overRe);
    hits.push({ f, line: i + 1, ts, snip: l.slice(Math.max(0, idx - 200), idx + 300).replace(/\\n/g, ' ') });
  }
}
console.log(JSON.stringify({ jsonl, md, hitCount: hits.length }));
for (const h of hits.slice(0, 40)) console.log('---', h.f, h.line, h.ts, '\n', h.snip);
