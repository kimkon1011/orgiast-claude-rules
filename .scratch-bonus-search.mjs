import fs from 'node:fs';
import path from 'node:path';
const roots = [path.join(process.env.USERPROFILE, '.claude', 'projects')];
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p); } };
roots.forEach(walk);
const echo = /1793238551765|120%を超えた分の数%|人事評価120%超過分|120%超過分を賞与|超過分の賞与相談/;
const pats = [
  /120[%％][\s\S]{0,300}(賞与|ボーナス|人事評価)|(賞与|ボーナス|人事評価)[\s\S]{0,300}120[%％]/,
  /(超過分|超えた分|上回った分)[\s\S]{0,300}(賞与|ボーナス)|(賞与|ボーナス)[\s\S]{0,300}(超過分|超えた分|上回った分)/,
];
const hits = [];
for (const f of files) {
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = txt.split('\n');
  lines.forEach((l, i) => {
    let s = l;
    try { const o = JSON.parse(l); s = JSON.stringify(o.message?.content ?? o).replace(/\\n/g, ' '); } catch {}
    if (echo.test(s)) return;
    for (const p of pats) { const m = s.match(p); if (m) { hits.push({ f: path.relative(roots[0], f), i: i + 1, ts: (l.match(/"timestamp":"([^"]+)"/) || [])[1], snip: s.slice(Math.max(0, m.index - 80), m.index + 220) }); break; } }
  });
}
console.log('files', files.length, 'hits', hits.length);
for (const h of hits.slice(0, 60)) console.log(JSON.stringify(h));
