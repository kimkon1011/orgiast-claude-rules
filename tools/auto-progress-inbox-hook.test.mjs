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

test('宛先の設定案内はSessionStartのみ1日1回で進捗と共存する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-notice-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'owner-discord-setup.json'), JSON.stringify({ owner: 'owner@example.com' }));
  const options = { home, now: new Date('2026-10-27T12:00:00Z') };
  assert.equal(consumeInbox({ session_id: 's', hook_event_name: 'UserPromptSubmit' }, options), null);
  appendInbox(home, 's', { state: 'done', evidence: '検証済み' });
  const input = { session_id: 's', hook_event_name: 'SessionStart' };
  const context = consumeInbox(input, options).hookSpecificOutput.additionalContext;
  assert.match(context, /自分の Discord ユーザー名を教えてください/);
  assert.match(context, /検証済み/);
  assert.equal(consumeInbox({ ...input, session_id: 's2' }, options), null);
  assert.ok(consumeInbox(input, { home, now: new Date('2026-10-28T12:00:00Z') }));
});
