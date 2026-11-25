import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookMain } from './session-purpose-gate.mjs';
test('start/first prompt/drift notices explicitly exempt inbox relay and replies', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'purpose-relay-'));
  const old = process.env.ORGIAST_HOME; process.env.ORGIAST_HOME = home;
  const output = []; t.mock.method(console, 'log', value => output.push(JSON.parse(value)));
  t.after(() => { if (old === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = old; });
  const send = (hook_event_name, prompt) => hookMain(JSON.stringify({ session_id: 'test', hook_event_name, prompt }));
  await send('SessionStart'); await send('UserPromptSubmit', 'ウェブサイトの表示を修正する');
  for (let i=0;i<4;i++) await send('UserPromptSubmit', '続きを修正して');
  await send('UserPromptSubmit', '別件ですが、全社員の経費精算と請求書管理の自動化を進めて');
  assert.equal(output.length, 3);
  for (const value of output) assert.match(value.hookSpecificOutput.additionalContext, /kim-inbox の【受信箱】節とその返答記録は目的外ではない/);
});
