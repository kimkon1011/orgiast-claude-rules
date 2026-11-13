import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureKimEditor } from './lib/kim-editor.mjs';
import { extractCreatedFiles, handle } from './kim-editor-posttool.mjs';
import { sweep, sweepAccounts, sweepQuery } from './kim-editor-sweep.mjs';
import fs from 'node:fs';
import { collapseHooks, repositoryHooks } from './hook-dispatch-registry.mjs';

const permission = role => ({ type: 'user', emailAddress: 'kim@orgiast.jp', role });
function drive(initial = [], { persist = true, fail = false } = {}) {
  let permissions = initial;
  const calls = [];
  return { calls, api: async (token, url, options = {}) => {
    calls.push({ token, url, ...options });
    if (options.method === 'POST') {
      if (fail) throw new Error('403 denied');
      if (persist) permissions = [permission('writer')];
      return Response.json({ id: 'permission' });
    }
    return Response.json({ permissions });
  } };
}
test('missing permission is granted without email and read back', async () => {
  const mock = drive();
  assert.equal((await ensureKimEditor('file', { token: 'fixture', api: mock.api })).changed, true);
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(JSON.parse(mock.calls[1].body), permission('writer'));
  assert.match(mock.calls[1].url, /sendNotificationEmail=false/);
  assert.ok(mock.calls.every(c => c.url.includes('supportsAllDrives=true')));
});
for (const role of ['writer', 'owner', 'organizer', 'fileOrganizer']) test(`${role} skips permission creation`, async () => {
  const mock = drive([permission(role)]);
  assert.equal((await ensureKimEditor('file', { token: 'fixture', api: mock.api })).changed, false);
  assert.equal(mock.calls.length, 1);
});
for (const role of ['reader', 'commenter']) test(`${role} is upgraded`, async () => {
  const mock = drive([permission(role)]);
  assert.equal((await ensureKimEditor('file', { token: 'fixture', api: mock.api })).changed, true);
});
test('permission API and read-back failures are exceptions', async () => {
  for (const options of [{ fail: true }, { persist: false }]) {
    await assert.rejects(ensureKimEditor('file', { token: 'fixture', api: drive([], options).api }), /denied|read-back/);
  }
});
test('acting user reaches DWD and permission pagination is honored', async () => {
  let count = 0;
  const result = await ensureKimEditor('file', {
    actingUser: 'cr@orgiast.jp', getToken: async opts => { assert.equal(opts.impersonate, 'cr@orgiast.jp'); return 'fixture'; },
    api: async (_token, url) => {
      if (++count === 1) return Response.json({ permissions: [], nextPageToken: 'next' });
      assert.match(url, /pageToken=next/); return Response.json({ permissions: [permission('writer')] });
    },
  });
  assert.equal(result.changed, false);
});
test('MCP results extract structured, JSON text and document URLs without sheet IDs', () => {
  assert.deepEqual(extractCreatedFiles({ content: [{ type: 'text', text: JSON.stringify({ spreadsheetId: 'book', sheets: [{ id: 'tab' }] }) }] }).map(f => f.id), ['book']);
  for (const key of ['id', 'fileId', 'documentId', 'presentationId']) assert.equal(extractCreatedFiles({ [key]: 'file' })[0].id, 'file');
  assert.equal(extractCreatedFiles('https://docs.google.com/document/d/abc/edit')[0].id, 'abc');
});
test('creation hook grants as owner; failed grant returns corrective context', async () => {
  const input = { tool_name: 'mcp__claude_ai_Google_Drive__copy_file', tool_response: { id: 'file', owners: [{ emailAddress: 'cr@orgiast.jp' }] } };
  let called = 0;
  assert.equal(await handle(input, { ensure: async (id, opts) => { called++; assert.equal(id, 'file'); assert.equal(opts.actingUser, 'cr@orgiast.jp'); } }), null);
  assert.equal(called, 1);
  const failed = await handle(input, { ensure: async () => { throw new Error('denied'); } });
  assert.match(failed.hookSpecificOutput.additionalContext, /kim 編集権限の付与に失敗: denied。その場で直すこと/);
  assert.equal(await handle({ tool_name: 'mcp__claude_ai_Google_Drive__list_files' }), null);
  assert.ok((await handle({ ...input, tool_response: {} })).hookSpecificOutput);
});
test('sweep targets registered execution accounts and excludes private files', async () => {
  const map = { pc: { account: 'cr@orgiast.jp' }, person: { email: 'staff@orgiast.jp' }, _unverified: { account: 'private@orgiast.jp' }, external: { account: 'private@gmail.com' } };
  assert.deepEqual(sweepAccounts(map), ['seisaku-team@orgiast.jp', 'kim@orgiast.jp', 'cr@orgiast.jp']);
  assert.match(sweepQuery('cr@orgiast.jp', '2026-11-06'), /properties has.*orgiastAutomation/);
  assert.match(sweepQuery('cr@orgiast.jp', '2026-11-06'), /2026-10-30/);
  const calls = [], inbox = [];
  const result = await sweep({ map, getToken: async ({ impersonate }) => impersonate,
    api: async (account, url) => { assert.match(decodeURIComponent(url), /owners/); return Response.json({ files: [{ id: account.split('@')[0], owners: [{ emailAddress: account }] }, { id: 'private', owners: [{ emailAddress: 'staff@orgiast.jp' }] }] }); },
    ensure: async id => { calls.push(id); return { changed: id === 'cr' }; }, inbox: async (_home, item) => inbox.push(item),
  });
  assert.deepEqual(calls, ['seisaku-team', 'kim', 'cr']);
  assert.equal(result.granted, 1); assert.equal(inbox[0].kind, 'info');
});
test('sweep reports and throws failures instead of claiming success', async () => {
  const rows = [];
  await assert.rejects(sweep({ map: {}, getToken: async () => { throw new Error('denied'); }, inbox: async (_home, row) => rows.push(row) }), /巡回に失敗/);
  assert.match(rows[0].text, /失敗 2件/);
});
test('hook is registered synchronously and cannot be load-shed; daily sweep is distributed', () => {
  const hook = collapseHooks(repositoryHooks(process.cwd(), process.cwd())).manifest.events.PostToolUse.find(h => h.name === 'kim-editor-posttool.mjs');
  assert.ok(hook); assert.equal(hook.async, undefined); assert.equal(hook.critical, true);
  assert.ok(hook.timeout >= 90);
  const manifest = JSON.parse(fs.readFileSync(new URL('setup-manifest.json', import.meta.url)));
  assert.ok(manifest.items.some(i => i.id === 'task:kim-editor-sweep' && i.repair.includes('register-kim-editor-sweep.mjs')));
  const ps1 = fs.readFileSync(new URL('register-kim-editor-sweep.ps1', import.meta.url), 'utf8');
  assert.match(ps1, /New-ScheduledTaskTrigger -Daily -At '05:50'/);
  assert.match(ps1, /Get-ScheduledTask -TaskName 'OrgiastKimEditorSweep'/);
});
test('GAS inbox receipt is acknowledged only after durable inbox delivery', async () => {
  const sequence = [];
  await sweep({ map: {}, getToken: async opts => opts.impersonate, ensure: async () => ({ changed: false }),
    api: async (account, url, options = {}) => {
      if (url.includes('alt=media')) return Response.json({ kind: 'action', text: '確認してください' });
      if (options.method === 'PATCH') { sequence.push('ack'); return Response.json({}); }
      return Response.json({ files: account === 'kim@orgiast.jp' ? [{ id: 'queued', owners: [{ emailAddress: account }], properties: { orgiastKimInbox: 'pending' } }] : [] });
    }, inbox: async (_home, item) => { if (item.source === 'feedback-gas') { sequence.push('inbox'); assert.equal(item.kind, 'ask'); assert.equal(item.dedupeKey, 'gas-inbox:queued'); } },
  });
  assert.deepEqual(sequence, ['inbox', 'ack']);
});
