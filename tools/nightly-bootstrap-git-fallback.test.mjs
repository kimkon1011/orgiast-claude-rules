import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./nightly-bootstrap.ps1', import.meta.url), 'utf8');
test('nightly-bootstrap は PATH に git が無くても既定の設置先から git を探す（2026-10-12 作業用011）', () => {
  assert.match(src, /Git\\cmd\\git\.exe/);
  assert.match(src, /if \(-not \$git -and/);
});
