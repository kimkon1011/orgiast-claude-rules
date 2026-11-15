import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { automationModel } from './lib/automation-model.mjs';
import { disabledLanes } from './lib/lane-disabled.mjs';
import { splitRepeatedGateBlocks } from './lib/stop-recheck.mjs';

test('自動実行のモデルは既定 sonnet、opus/fable 指定も sonnet に倒す', () => {
  assert.equal(automationModel(undefined, {}), 'sonnet');
  assert.equal(automationModel('claude-opus-5', {}), 'sonnet');
  assert.equal(automationModel('claude-fable-5-1', {}), 'sonnet');
  assert.equal(automationModel('haiku', {}), 'haiku');
  assert.equal(automationModel('', { ORGIAST_AUTOMATION_MODEL: 'haiku' }), 'haiku');
  assert.equal(automationModel('', { ORGIAST_AUTOMATION_MODEL: 'opus' }), 'sonnet');
});

test('lanes-disabled.json の gemini は gemini-cli も無効にする', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lanedis-'));
  assert.equal(disabledLanes(home).size, 0);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'lanes-disabled.json'), JSON.stringify({ gemini: { reason: 'test' } }));
  const set = disabledLanes(home);
  assert.ok(set.has('gemini') && set.has('gemini-cli'));
  assert.ok(!set.has('deepseek'));
});

test('同じゲートは同じターンで1回だけ block し、2回目は repeated になる。新しいターンでは再び block', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stoprep-'));
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', promptId: 'p1', message: { role: 'user', content: 'a' } }) + '\n');
  const input = { session_id: 's1', transcript_path: transcript };
  assert.deepEqual(splitRepeatedGateBlocks({ input, gates: ['g1', 'g2'], home }), { allowed: ['g1', 'g2'], repeated: [] });
  assert.deepEqual(splitRepeatedGateBlocks({ input, gates: ['g1', 'g3'], home }), { allowed: ['g3'], repeated: ['g1'] });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', promptId: 'p2', message: { role: 'user', content: 'b' } }) + '\n');
  assert.deepEqual(splitRepeatedGateBlocks({ input, gates: ['g1'], home }), { allowed: ['g1'], repeated: [] });
});
