import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './discord-group-dm-request.mjs';

function fixture(t, body = '倉庫の確認をお願いします。') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-dm-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'body.txt');
  fs.writeFileSync(file, body);
  return file;
}

async function captureLog(run) {
  const original = console.log;
  const lines = [];
  console.log = value => lines.push(String(value));
  try { return { code: await run(), lines }; }
  finally { console.log = original; }
}

test('依頼本文に相手名・本文・グループDM手順・Bot DMフォールバックが入る', async t => {
  const file = fixture(t);
  let sent;
  const code = await main(['澤田', '--body-file', file, '--chat', '倉庫チーム'], {
    resolveFleetLabel: () => 'cr-PC',
    sendFleet: async body => { sent = body; return 0; },
  });
  assert.equal(code, 0);
  assert.match(sent, /相手名: 澤田/);
  assert.match(sent, /グループDM名の候補: 倉庫チーム/);
  assert.match(sent, /倉庫の確認をお願いします。/);
  assert.match(sent, /discord-read-window\.ps1/);
  assert.match(sent, /discord-post\.ps1/);
  assert.match(sent, /discord-dm\.mjs "澤田"/);
  assert.match(sent, /金功勇への写しは自動/);
});

test('kim-PCではfleet-mailを呼ばず手順を表示してexit 4', async t => {
  const file = fixture(t);
  let calls = 0;
  const result = await captureLog(() => main(['澤田', '--body-file', file], {
    resolveFleetLabel: () => 'kim-PC', sendFleet: async () => { calls++; },
  }));
  assert.equal(result.code, 4);
  assert.equal(calls, 0);
  assert.match(result.lines.join('\n'), /discord-read-window\.ps1/);
});

test('dry-runはfleet-mailを呼ばず依頼本文をJSONで返す', async t => {
  const file = fixture(t, '至急確認してください。');
  let calls = 0;
  const result = await captureLog(() => main(['白川', '--body-file', file, '--dry-run'], {
    resolveFleetLabel: () => 'cr-PC', sendFleet: async () => { calls++; },
  }));
  assert.equal(result.code, 0);
  assert.equal(calls, 0);
  const output = JSON.parse(result.lines[0]);
  assert.equal(output.dryRun, true);
  assert.match(output.requestBody, /白川/);
  assert.match(output.requestBody, /至急確認してください。/);
});
