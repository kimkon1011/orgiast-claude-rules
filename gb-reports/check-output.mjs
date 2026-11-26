import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const baks = fs.readdirSync(dir).filter(f => f.includes('bak'));
console.log('Backup files:', baks);

// Restore
if (baks.length > 0) {
  fs.copyFileSync(path.join(dir, baks[0]), path.join(dir, 'sample-next-session.md'));
  console.log('Restored from', baks[0]);
}

// Read the restored file
const restored = fs.readFileSync(path.join(dir, 'sample-next-session.md'), 'utf8');
console.log('\n--- Restored file ---');
console.log(restored);
console.log('--- End ---');