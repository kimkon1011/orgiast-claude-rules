import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { appendInbox, consumeInbox, inboxFile } from './auto-progress-inbox-hook.mjs';

test('inbox を hook に注入して既読化する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-inbox-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  appendInbox(home, 's1', { state: 'done', evidence: '検証済み', artifact: 'out/report.html' });
  const out = consumeInbox({ session_id: 's1', hook_event_name: 'SessionStart' }, { home });
  assert.match(out.hookSpecificOutput.additionalContext, /📲 自動進行の結果: done: 検証済み（成果物: out\/report.html）/);
  assert.equal(consumeInbox({ session_id: 's1' }, { home }), null);
  assert.equal(JSON.parse(fs.readFileSync(inboxFile(home, 's1'), 'utf8')).shown, true);
});
