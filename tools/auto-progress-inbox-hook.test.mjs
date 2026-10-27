import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { appendOwnerInbox, appendInbox, consumeInbox, inboxFile } from './auto-progress-inbox-hook.mjs';

test('inbox を hook に注入して既読化する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-inbox-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  appendInbox(home, 's1', { state: 'done', evidence: '検証済み', artifact: 'out/report.html' });
  const out = consumeInbox({ session_id: 's1', hook_event_name: 'SessionStart' }, { home });
  assert.match(out.hookSpecificOutput.additionalContext, /done: 検証済み（成果物: out\/report.html）/);
  assert.equal(consumeInbox({ session_id: 's1' }, { home }), null);
  assert.equal(JSON.parse(fs.readFileSync(inboxFile(home, 's1'), 'utf8')).shown, true);
});

test('owner inbox は別セッションで最新全文と古い件数を表示し一度だけ既読化する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-inbox-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  appendOwnerInbox(home, { source: 'notify-owner', text: '古い通知' });
  appendInbox(home, 'original', { evidence: '別セッション専用' });
  appendOwnerInbox(home, { source: 'digest', text: 'あなたの判断待ち\nあなたの判断待ち\n' + '長'.repeat(1600) });
  const out = consumeInbox({ session_id: 'new', hook_event_name: 'SessionStart' }, { home });
  const context = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(context, /📲 自動進行の結果（聞かれる前にお知らせ）/);
  assert.equal(context.match(/あなたの判断待ち/g).length, 1);
  assert.ok(context.includes(('あなたの判断待ち\n' + '長'.repeat(1600)).slice(0, 1500)));
  assert.ok(!context.includes('長'.repeat(1500)));
  assert.match(context, /ほか 1 件（古い通知）/);
  assert.equal(consumeInbox({ session_id: 'third' }, { home }), null);
  const rows = fs.readFileSync(inboxFile(home, '_owner'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.every(row => row.shown && row.shownAt && row.shownSession === 'new'));
  assert.equal(JSON.parse(fs.readFileSync(inboxFile(home, 'original'), 'utf8')).shown, false);
});

test('owner inbox の24時間抑止は未表示同文だけに適用する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-dedupe-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const add = () => appendOwnerInbox(home, { source: 'notify-owner', text: '結果' });
  const rows = () => fs.readFileSync(inboxFile(home, '_owner'), 'utf8').trim().split('\n').map(JSON.parse);
  add(); add(); assert.equal(rows().length, 1);
  const file = inboxFile(home, '_owner');
  fs.writeFileSync(file, JSON.stringify({ ...rows()[0], at: new Date(Date.now() - 86400001).toISOString() }) + '\n');
  add(); assert.equal(rows().length, 2);
  assert.equal(consumeInbox({ session_id: 's', hook_event_name: 'UserPromptSubmit' }, { home }).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  add(); assert.equal(rows().length, 3);
});
