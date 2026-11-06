import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REMINDER, counterFile, main } from './intra-turn-progress-reminder.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intra-turn-progress-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, env: {}, now: 1234 };
}

test('3回目で fire し、0へリセット後も再び3回目で fire', t => {
  const options = fixture(t);
  assert.equal(main({ session_id: 's1' }, options).state.count, 1);
  assert.equal(main({ session_id: 's1' }, options).state.count, 2);
  const third = main({ session_id: 's1' }, options);
  assert.equal(third.emitted, REMINDER);
  assert.deepEqual(JSON.parse(fs.readFileSync(counterFile(options.home, 's1'), 'utf8')), { count: 0, lastReminderAt: 1234 });
  assert.equal(main({ session_id: 's1' }, options).emitted, null);
  assert.equal(main({ session_id: 's1' }, options).emitted, null);
  assert.equal(main({ session_id: 's1' }, options).emitted, REMINDER);
});

test('環境変数で閾値を5に変更', t => {
  const options = { ...fixture(t), env: { INTRA_TURN_PROGRESS_THRESHOLD: '5' } };
  for (let i = 0; i < 4; i++) assert.equal(main({ sessionId: 's2' }, options).emitted, null);
  assert.equal(main({ sessionId: 's2' }, options).emitted, REMINDER);
});

test('disable、session IDなし、無人セッションはスキップ', t => {
  const options = fixture(t);
  assert.equal(main({ session_id: 'disabled' }, { ...options, env: { INTRA_TURN_PROGRESS_DISABLED: '1' } }).emitted, null);
  assert.equal(main({}, options).emitted, null);
  assert.equal(main({ session_id: 'headless' }, { ...options, env: { CLAUDE_HEADLESS: '1' } }).emitted, null);
  assert.equal(fs.existsSync(path.join(options.home, '.claude')), false);
});

test('壊れたカウンタファイルでも例外なく継続', t => {
  const options = fixture(t);
  const file = counterFile(options.home, 'broken');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  assert.doesNotThrow(() => main({ session_id: 'broken' }, options));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).count, 1);
});

test('CLI stdout は仕様通り1行、改行なし', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intra-turn-progress-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./intra-turn-progress-reminder.mjs', import.meta.url));
  const env = { ...process.env, HOME: home, USERPROFILE: home, INTRA_TURN_PROGRESS_THRESHOLD: '1' };
  const result = spawnSync(process.execPath, [script], { input: '{"session_id":"stdout"}', encoding: 'utf8', env });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, REMINDER);
  assert.doesNotMatch(result.stdout, /[\r\n]/);
});
