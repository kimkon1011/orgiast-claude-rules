import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { main } from './register-morning-session-sweep.mjs';
test('setup repair registration and readback failure',async()=>{
  const spawnImpl=()=>({status:0,stdout:''});
  assert.equal(await main({platform:'win32',spawnImpl,getTaskInfo:async()=>({name:'OrgiastMorningSessionSweep'})}),0);
  await assert.rejects(main({platform:'win32',spawnImpl,getTaskInfo:async()=>null}),/read-back/);
  const source=fs.readFileSync(new URL('./register-morning-session-sweep.ps1',import.meta.url),'utf8');
  assert.match(source,/New-ScheduledTaskTrigger -Daily -At '06:30'/);assert.match(source,/New-HiddenScheduledTaskAction/);assert.match(source,/Get-ScheduledTask/);
  const manifest=JSON.parse(fs.readFileSync(new URL('./setup-manifest.json',import.meta.url)));
  assert.deepEqual(manifest.items.find(x=>x.id==='task:morning-session-sweep').repair,['register-morning-session-sweep.mjs']);
});
