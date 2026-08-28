import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const h = process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
try { const s = fs.readFileSync(path.join(h, '.claude', 'rule-compliance.md'), 'utf8'); if (s.trim()) process.stdout.write(s); } catch {}
