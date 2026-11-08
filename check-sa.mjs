import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
console.log('__dirname:', __dirname);
// Check for common SA key locations
const candidates = [
  join(__dirname, 'tools', 'lib', 'sheets-sa.json'),
  join('C:', 'Users', 'kimko', '.claude', 'sheets-sa.json'),
  join('C:', 'Users', 'kimko', '.claude', 'keys', 'sheets-sa.json'),
  join('C:', 'Users', 'kimko', '.claude', 'drive-sa.json'),
];
for (const f of candidates) {
  console.log(f, existsSync(f) ? 'EXISTS' : 'NOT_FOUND');
}
