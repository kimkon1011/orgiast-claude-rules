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

test('owner inbox は別セッションで最大120字の各通知を表示し一度だけ既読化する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-inbox-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  appendOwnerInbox(home, { source: 'notify-owner', text: '古い通知' });
  appendInbox(home, 'original', { evidence: '別セッション専用' });
  appendOwnerInbox(home, { source: 'digest', text: 'あなたの判断待ち\nあなたの判断待ち\n' + '長'.repeat(1600) });
  const out = consumeInbox({ session_id: 'new', hook_event_name: 'SessionStart' }, { home });
  const context = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(context, /📲 自動進行の結果（聞かれる前にお知らせ）/);
  assert.equal(context.match(/あなたの判断待ち/g).length, 2);
  assert.ok(context.includes(('あなたの判断待ち あなたの判断待ち ' + '長'.repeat(1600)).slice(0, 120)));
  assert.ok(!context.includes('長'.repeat(1500)));
  assert.match(context, /古い通知/);
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

for (const state of ['done', 'needs_user', 'blocked']) {
  for (const first of ['original', 'other']) test(`${state}: ${first}で表示すると両方既読`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    appendInbox(home, 'original', { state, evidence: '固有通知本文' });
    const read = id => JSON.parse(fs.readFileSync(inboxFile(home, id), 'utf8'));
    assert.equal(read('original').id, read('_owner').id);
    const context = consumeInbox({ session_id: first }, { home, env: {} }).hookSpecificOutput.additionalContext;
    assert.equal(context.match(/固有通知本文/g).length, 1);
    assert.equal(read('original').shown, true);
    assert.equal(read('_owner').shown, true);
    assert.equal(consumeInbox({ session_id: first === 'original' ? 'other' : 'original' }, { home, env: {} }), null);
  });
}
for (const input of [
  { env: { CLAUDE_HEADLESS: '1' } },
  { env: { ORGIAST_HEADLESS_JOB: 'quota' } },
  { cwd: 'QUOTA' },
  { cwd: 'C:/Windows/system32' },
  { entrypoint: 'sdk-cli' },
  { entryPoint: 'sdk-ide' },
]) test(`無人は読み書きせず、次の対話に残す: ${JSON.stringify(input)}`, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  appendInbox(home, 'original', { state: 'done', evidence: '届く結果' });
  const files = ['original', '_owner'].map(id => inboxFile(home, id));
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  const hookInput = { session_id: 'original', ...input, ...(input.cwd === 'QUOTA' ? { cwd: path.join(home, '.claude/quota-sweep-repo/sub') } : {}) };
  assert.equal(consumeInbox(hookInput, { home, env: input.env || {} }), null);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  assert.match(consumeInbox({ session_id: 'interactive' }, { home, env: {} }).hookSpecificOutput.additionalContext, /届く結果/);
});
test('owner は新しい順に5件・1行120字、残りは次回表示', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'five-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (let i = 0; i < 7; i++) appendInbox(home, '_owner', { at: new Date(1000 + i).toISOString(), text: `${i}:` + '長'.repeat(130) + '\n末尾' });
  const context = consumeInbox({ session_id: 's' }, { home, env: {} }).hookSpecificOutput.additionalContext;
  assert.match(context, /ほか 2 件/);
  assert.ok(context.indexOf('6:') < context.indexOf('5:'));
  assert.ok(!context.includes('1:'));
  assert.ok(!context.includes('長'.repeat(119)));
  const next = consumeInbox({ session_id: 's' }, { home, env: {} }).hookSpecificOutput.additionalContext;
  assert.match(next, /1:/); assert.match(next, /0:/);
  assert.equal(consumeInbox({ session_id: 's' }, { home, env: {} }), null);
});

function warningOptions(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recipient-warning-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, env: {}, label: 'test-PC', pcMap: { 'test-PC': { account: 'owner@example.com' } }, directory: [], now: new Date(2026, 10, 3, 9).getTime() };
}

test('宛先空なら先頭に警告し同日別セッションは抑止、翌日は再表示', t => {
  const options = warningOptions(t);
  appendInbox(options.home, 's1', { evidence: '通常の結果' });
  const out = consumeInbox({ session_id: 's1' }, options);
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith('⚠ 進捗DMの宛先が未登録（PC: test-PC / owner@example.com）:'));
  assert.match(out.hookSpecificOutput.additionalContext, /通常の結果/);
  const file = path.join(options.home, '.claude', 'auto-progress-inbox', '_recipient-warning.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).at, new Date(options.now).toISOString());
  assert.equal(consumeInbox({ session_id: 's2' }, options), null);
  appendInbox(options.home, 's2', { evidence: '次の結果' });
  const next = consumeInbox({ session_id: 's2' }, options).hookSpecificOutput.additionalContext;
  assert.match(next, /次の結果/);
  assert.doesNotMatch(next, /⚠ 進捗DM/);
  options.now = new Date(2026, 10, 4, 0).getTime();
  assert.match(consumeInbox({ session_id: 's3' }, options).hookSpecificOutput.additionalContext, /^⚠ 進捗DM/);
});

test('宛先ありなら警告も警告記録も出さない', t => {
  const options = warningOptions(t);
  options.pcMap['test-PC'].notifyDiscordId = '42';
  assert.equal(consumeInbox({ session_id: 's1' }, options), null);
  appendInbox(options.home, 's1', { evidence: '通常の結果' });
  const out = consumeInbox({ session_id: 's1' }, options);
  assert.match(out.hookSpecificOutput.additionalContext, /通常の結果/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /⚠ 進捗DM/);
  assert.equal(fs.existsSync(path.join(options.home, '.claude', 'auto-progress-inbox', '_recipient-warning.json')), false);
});

test('無人・session IDなしでは警告の表示済み時刻を記録しない', t => {
  const options = warningOptions(t);
  assert.equal(consumeInbox({}, options), null);
  assert.equal(consumeInbox({ session_id: 's1' }, { ...options, env: { CLAUDE_HEADLESS: '1' } }), null);
  assert.equal(fs.existsSync(path.join(options.home, '.claude', 'auto-progress-inbox', '_recipient-warning.json')), false);
  assert.match(consumeInbox({ session_id: 's1' }, options).hookSpecificOutput.additionalContext, /^⚠ 進捗DM/);
});
