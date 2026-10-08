import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionLaneHealth } from './sessionstart-lane-health.mjs';
test('SessionStart returns one-line summary and saves offline health',t=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'session-lane-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const r=sessionLaneHealth({home});assert.equal(r.hookSpecificOutput.hookEventName,'SessionStart');assert.match(r.hookSpecificOutput.additionalContext,/生存:.*停止:.*修復:/);assert.ok(!r.hookSpecificOutput.additionalContext.includes('\n'));assert.ok(fs.existsSync(path.join(home,'.claude/lane-health.json')));});
