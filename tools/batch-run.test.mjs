import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { batchDeadline } from './lib/batch-deadline.mjs';

test('batch deadline defaults to local 06:30 and accepts override', () => {
  const now = new Date(2026, 8, 10, 3, 0);
  assert.equal(batchDeadline(now, '06:30').getHours(), 6);
  assert.equal(batchDeadline(now, '05:45').getMinutes(), 45);
  assert.throws(() => batchDeadline(now, '25:00'), /invalid/);
});

test('生存中のbatch-run lockがあれば即時exit 0', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'batch-lock-'));
  const dir=path.join(home,'.claude','locks'); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'batch-run.lock'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  const started=Date.now(); const result=spawnSync(process.execPath,['tools/batch-run.mjs','--dry'],{encoding:'utf8',env:{...process.env,ORGIAST_LOCK_HOME:home,ORGIAST_HOME:home}});
  assert.equal(result.status,0); assert.match(result.stderr,/\[batch-run\] already running pid=/); assert.ok(Date.now()-started<1000);
  fs.rmSync(home,{recursive:true,force:true});
});
