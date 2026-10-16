import fs from 'node:fs';
import path from 'node:path';
export function expectationLog(home, exp) {
  const dir = path.join(home, '.claude', 'logs');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const matches = exp.pattern ? files.filter(f => new RegExp(exp.pattern).test(f)) : files.filter(f => f === exp.log);
  return matches.map(file => ({ file, mtimeMs: fs.statSync(path.join(dir,file)).mtimeMs })).sort((a,b) => b.mtimeMs-a.mtimeMs)[0] || null;
}
export function logIsStale(mtimeMs, maxAgeHours, now) { return (now - mtimeMs) / 3600000 > maxAgeHours; }
