import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readConfig, userHome } from '../scout-overlay/tools/eval-harness.mjs';

const recovered = JSON.parse(fs.readFileSync(new URL('recovered-providers.json', import.meta.url), 'utf8'));
const destination = path.join(userHome(), '.claude', 'eval', 'providers.local.json');
let existing = [];
try { existing = JSON.parse(fs.readFileSync(destination, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
assert.ok(Array.isArray(existing), 'Existing overlay must be an array');
const merged = [...existing];
for (const row of recovered) {
  const found = merged.find((x) => x.provider === row.provider && x.model === row.model);
  if (found) assert.deepEqual(found, row, 'Conflicting entry: abort without overwriting');
  else merged.push(row);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
const temporary = `${destination}.${process.pid}.tmp`;
fs.writeFileSync(temporary, JSON.stringify(merged, null, 2) + '\n', { flag: 'wx' });
fs.renameSync(temporary, destination);
assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), merged);
const targets = readConfig({ overlayFile: destination });
for (const row of recovered) assert.deepEqual(targets.find((x) => x.provider === row.provider && x.model === row.model), row);
console.log('Verified all four candidates in overlay and eval target list:');
console.log(JSON.stringify(recovered, null, 2));
const nightly = path.join(userHome(), '.claude', 'nightly-repo');
const status = execFileSync('git', ['-C', nightly, 'status', '--short'], { encoding: 'utf8' });
console.log('nightly-repo status:', status || '(clean; checkout not needed)');
fs.writeFileSync(new URL('recovery-result.json', import.meta.url), JSON.stringify({ destination, recovered, nightlyStatus: status, verifiedAt: new Date().toISOString() }, null, 2) + '\n');
