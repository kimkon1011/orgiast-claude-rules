import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convergeDeadlineTasks } from './setup-deadline-watch.mjs';
const VALID_SEAT = { kim: true, kimOperated: true, dwdKey: true };
test('期限タスクはkim席のWindowsだけでconverge、登録失敗をNGにする', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'deadline-setup-')); t.after(() => fs.rmSync(home,{recursive:true,force:true}));
  const fail = () => assert.fail('他PCで登録禁止');
  assert.equal(convergeDeadlineTasks({ home, platform:'win32', run:fail }).status,'NOTICE');
  fs.writeFileSync(path.join(home,'.claude.json'), JSON.stringify({oauthAccount:{emailAddress:'kim@orgiast.jp'}}));
  assert.equal(convergeDeadlineTasks({ home, platform:'linux', run:fail }).status,'NOTICE');
  const result = convergeDeadlineTasks({ home, platform:'win32', seat: VALID_SEAT, run:(cmd,args,options) => {
    assert.equal(cmd,'powershell.exe'); assert.ok(args.includes('-Ensure')); assert.equal(options.windowsHide,true);
    assert.equal(options.env.ORGIAST_HOME,home); return 'registered: OrgiastDeadlineWatch';
  }});
  assert.equal(result.status,'OK'); assert.equal(result.repaired,true);
  assert.equal(convergeDeadlineTasks({home,platform:'win32',seat:VALID_SEAT,run:()=>{throw Error('registration failed');}}).status,'NG');
});
test('dwdKey不足の席はNOTICEになり登録されない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'deadline-setup-')); t.after(() => fs.rmSync(home,{recursive:true,force:true}));
  fs.writeFileSync(path.join(home,'.claude.json'), JSON.stringify({oauthAccount:{emailAddress:'kim@orgiast.jp'}}));
  assert.equal(convergeDeadlineTasks({ home, platform:'win32', run:() => assert.fail('should not register') }).status,'NOTICE');
});
test('seatCheck構造が正しいキーを含む', async t => {
  const { seatCheck } = await import('./lib/deadline-seat.mjs');
  const s = seatCheck();
  assert.equal(typeof s.kim, 'boolean');
  assert.equal(typeof s.kimOperated, 'boolean');
  assert.equal(typeof s.dwdKey, 'boolean');
});
