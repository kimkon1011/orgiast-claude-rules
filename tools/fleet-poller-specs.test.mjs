import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

for (const name of ['fleet-poller.mjs','fleet-poller.ps1']) {
  const source=fs.readFileSync(new URL(`./${name}`,import.meta.url),'utf8');
  test(`${name} keeps specs and cloud wiring at the caller`,()=>{
    assert.match(source,/fleet-sheet-report\.mjs[^\n]*--specs/);
    assert.match(source,/fleet-sheet-report\.mjs[^\n]*--cloud/);
  });
}
