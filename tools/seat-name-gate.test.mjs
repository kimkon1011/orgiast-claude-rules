import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judge } from './seat-name-gate.mjs';
import { rolloutMode } from './gate-runtime.mjs';
const map = { desk: { hostname: 'DELL', remoteName: '作業用014' }, old: { hostname: 'DESKTOP-BDOAK99', remoteName: '作業用999' } };
for (const text of ['DELL 席', 'DELL PC', 'DELLのPC', 'DELL側', 'DELL の Codex ログインをお願いします', 'DELL（seisaku-team@）で確認', '作業用014 は DELL です', 'desk の状態', 'DESKTOP-BDOAK99', 'DESKTOP-ZZZZ999', '作業用0140（DELL 席）', '作業用999\nDESKTOP-BDOAK99']) test(`SEAT-NAME denies ${text}`, () => {
  assert.deepEqual(judge(text, map).reasonCodes, ['SEAT-NAME']);
});
for (const text of ['作業用014（hostname: DELL）', '作業用014（DELL 席）', '作業用999（DESKTOP-BDOAK99）', '番号未登録の席（hostname: DESKTOP-ZZZZ999）', 'Dell のモニタ', 'DELL P2422H', 'MYDELL 席', '```text\nDESKTOP-BDOAK99\n```', '~~~\nDESKTOP-ZZZZ999\n~~~', '`DELL 席`', 'https://example.com/DESKTOP-ZZZZ999', 'DELL 席 [SEAT-NAME-OK: 証跡]', 'DELL です [SEAT-NAME-OK: 製品名]', 'DESKTOP-ZZZZ999X']) test(`allows ${text}`, () => assert.equal(judge(text, map).decision, 'pass'));
test('DELL must be registered as hostname and remedy names assigned seat', () => {
  assert.equal(judge('DELL 席', {}).decision, 'pass');
  assert.equal(judge('DELL 席', { DELL: { remoteName: '作業用014' } }).decision, 'pass');
  assert.match(judge('DELL 席', map).reason, /DELL → 作業用014 と書く/);
});
for (const local of [String.raw`C:\Users\uers\AppData\Local\Temp\x.txt`, 'AppData/Local/Temp/x.txt', 'scratchpad/x.txt', String.raw`~\.claude\x.txt`, '~/.claude/x.txt']) test(`LOCAL-HANDOFF ${local}`, () => {
  assert.equal(judge(local, map).decision, 'pass');
  for (const gap of ['', '\n', '\n説明\n']) assert.deepEqual(judge('`' + local + '`' + gap + 'を開き、4行目をコピー', map).reasonCodes, ['LOCAL-HANDOFF']);
  assert.equal(judge(local + '\na\nb\nコピー', map).decision, 'pass');
  assert.equal(judge(local + ' を開いて [LOCAL-HANDOFF-OK: 調査引用]', map).decision, 'pass');
});
test('exceptions require reasons and are independent', () => {
  assert.equal(judge('DELL 席 [SEAT-NAME-OK: ]', map).decision, 'block');
  assert.deepEqual(judge('DELL 席 scratchpad/x をコピー [SEAT-NAME-OK: 証跡]', map).reasonCodes, ['LOCAL-HANDOFF']);
  assert.deepEqual(judge('DELL 席 scratchpad/x をコピー [LOCAL-HANDOFF-OK: 証跡]', map).reasonCodes, ['SEAT-NAME']);
});
test('Stop protocol reads latest assistant and returns block JSON', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-gate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'DESKTOP-ZZZZ999' }] } }) + '\n');
  const run = input => spawnSync(process.execPath, ['tools/seat-name-gate.mjs'], { encoding: 'utf8', input: JSON.stringify(input), env: { ...process.env, ORGIAST_HOME: home } });
  const blocked = run({ transcript_path: transcript, session_id: 'test' });
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');
  assert.match(JSON.parse(blocked.stdout).reason, /SEAT-NAME/);
  assert.equal(run({ transcript_path: transcript, last_assistant_message: '正常です' }).stdout, '');
  assert.equal(run({}).stdout, '');
  assert.equal(rolloutMode('seat-name-gate', { home, hostname: 'fresh-pc' }), 'deny');
});
