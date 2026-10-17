import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { issueApprovals, implApproved, billingApproved } from './claude-impl-approval.mjs';
function home(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }
for (const marker of ['[CLAUDE-IMPL-OK]', '[LANE-OK]', '[API-BILLING-OK]']) {
  test(`${marker}: session-bound approval expires at 60 minutes`, t => {
    const h = home(t), now = Date.now();
    const read = marker === '[API-BILLING-OK]' ? billingApproved : implApproved;
    assert.match(issueApprovals({ prompt: `許可 ${marker}`, session_id: 's' }, h, now)[0], /許可を発行/);
    assert.equal(read(h, 's', now).marker, marker);
    assert.equal(read(h, 'other', now), null);
    assert.equal(read(h, undefined, now), null);
    assert.equal(read(h, 's', now + 3600000), null);
    assert.equal((read === implApproved ? billingApproved : implApproved)(h, 's', now), null);
  });
  for (const prompt of [`${marker} は使うな`, `${marker} 禁止`, `禁止: ${marker}`, `do not use ${marker}`]) {
    test(`negative: ${prompt}`, t => assert.deepEqual(issueApprovals({ prompt, session_id: 's' }, home(t)), []));
  }
}
test('no session, wrong event, corrupt file fail open without granting', t => {
  const h = home(t);
  assert.deepEqual(issueApprovals({ prompt: '[CLAUDE-IMPL-OK]' }, h), []);
  assert.deepEqual(issueApprovals({ prompt: '[CLAUDE-IMPL-OK]', session_id: 's', hook_event_name: 'PreToolUse' }, h), []);
  fs.mkdirSync(path.join(h, '.claude')); fs.writeFileSync(path.join(h, '.claude/claude-impl-allow.json'), '{bad');
  assert.equal(implApproved(h, 's'), null);
});
test('hook stdin malformed/empty exits zero; valid marker issues context', t => {
  const h = home(t);
  for (const input of ['', '{bad', JSON.stringify({ prompt: '[CLAUDE-IMPL-OK]', session_id: 's' })]) {
    const r = spawnSync(process.execPath, ['tools/claude-impl-approval.mjs'], { input, encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: h } });
    assert.equal(r.status, 0); if (input.startsWith('{"')) assert.match(r.stdout, /additionalContext/); else assert.equal(r.stdout, '');
  }
});
