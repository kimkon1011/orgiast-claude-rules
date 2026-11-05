import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './auto-progress-digest.mjs';
import { main as inboxMain, addItem, listItems } from './kim-inbox.mjs';
import { defaultNotifyKim } from './vehicle-inspection-watch.mjs';
function seat(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(),'deadline-delivery-')); t.after(()=>fs.rmSync(home,{recursive:true,force:true})); fs.mkdirSync(path.join(home,'.claude')); fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'kim@orgiast.jp'}})); return home; }
test('朝まとめに期限だけでも先頭へ表示し、夜は追加しない', async t => {
  const home = seat(t), io = { localOwner:'kim@orgiast.jp', label:'other', readLedger:()=>[], readState:()=>({}), readDeadlineDigest:async()=> '今週の期限\nD-001 資料提出' };
  const result = await run({home,now:Date.parse('2026-11-04T00:00:00Z'),dryRun:true,slot:'朝',io});
  assert.match(result.text,/^今週の期限\nD-001 資料提出\n\n【進捗まとめ】/);
  const evening = await run({home,now:Date.parse('2026-11-04T09:00:00Z'),dryRun:true,slot:'夕',io:{...io,readDeadlineDigest:()=>assert.fail('夕は追加しない')}});
  assert.equal(evening.sent,false);
});
test('車検の実inbox経路は同じキーを更新し旧askを閉じる', async t => {
  const home=seat(t), row={id:'V01',name:'V220d',plate:'テスト123'};
  const body='【車検】V220d（テスト123）満了 2026-10-27（8日超過）\n次の一手: 入庫手配';
  await addItem(home,{kind:'ask',source:'vehicle-inspection',text:body});
  await defaultNotifyKim({home,kind:'deadline',body,key:row.id,due:'2026-10-27',remainingDays:-8,row});
  await defaultNotifyKim({home,kind:'deadline',body,key:row.id,due:'2026-10-27',remainingDays:-8,row});
  const items=listItems(home,{status:'open'}); assert.equal(items.length,1); assert.equal(items[0].key,'V01');
  assert.match(items[0].text,/^🔴 V01/);
  const output=[]; await inboxMain(['--context'],{home,stdout:x=>output.push(JSON.parse(x)),readStdin:async()=>'{"hook_event_name":"SessionStart","session_id":"test"}'});
  assert.match(output[0].hookSpecificOutput.additionalContext,/期限 1/);
});
