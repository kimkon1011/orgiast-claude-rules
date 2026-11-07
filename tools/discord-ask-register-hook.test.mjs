import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerHook, registerDiscord, MATCHER } from './discord-ask-register-hook.mjs';
import { readManualLedger, addManual } from './outbound-reply-chase.mjs';
import { context } from './kim-awaiting-context.mjs';
import { repositoryHooks } from './hook-dispatch-registry.mjs';
const NOW = Date.parse('2026-11-05T03:00:00Z');
const input = (overrides = {}) => ({ tool_name: 'mcp__claude_ai_Discord__send_dm', session_id: 's',
  tool_input: { content: '結果を送ってください', user_id: '715341783999184897' },
  tool_response: { message_id: '1564200779894489109', dm_channel_id: '1564200776778256475' }, ...overrides });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-chase-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, file: path.join(home, '.claude', 'reply-waiting.json'), now: NOW };
}
test('successful request stores the existing schema and metadata once, even after done', t => {
  const f = fixture(t);
  assert.equal(registerHook(input(), f), 1);
  let ledger = readManualLedger(f.file);
  assert.equal(ledger.entries.length, 1);
  assert.deepEqual(ledger.entries[0], { id: '715341783999184897-20261105', who: '715341783999184897', channel: 'Discord',
    sentAt: '2026-11-05', subject: '結果を送ってください', note: '', status: 'waiting', staleDays: 2,
    discord: { channelId: '1564200776778256475', messageId: '1564200779894489109', userId: '715341783999184897' }, session: 's' });
  assert.equal(registerHook(input(), f), 0);
  ledger.entries[0].status = 'done'; fs.writeFileSync(f.file, JSON.stringify(ledger));
  assert.equal(registerHook(input(), f), 0);
  assert.equal(readManualLedger(f.file).entries.length, 1);
});
test('nonrequests, errors, unrelated tools and missing IDs never register', t => {
  const f = fixture(t);
  for (const v of [
    input({ tool_input: { content: 'ありがとうございます', user_id: '1' } }),
    input({ tool_name: 'other' }), input({ tool_response: {} }),
    ...[{ isError: true }, { error: 'failed' }, { success: false }, { ok: false }].map(error => input({ tool_response: { ...input().tool_response, ...error } })),
    input({ tool_response: { message_id: '1' } }),
  ]) assert.equal(registerHook(v, f), 0);
  assert.equal(readManualLedger(f.file).entries.length, 0);
});
test('all six tools support MCP text blocks; reply uses the new message ID', t => {
  const f = fixture(t); let n = 10;
  for (const bot of ['Discord', 'Discord_2']) for (const action of ['send_dm', 'send_message', 'reply_message']) {
    const id = String(++n);
    assert.equal(registerHook(input({ tool_name: `mcp__claude_ai_${bot}__${action}`,
      tool_input: { content: '確認してください', user_id: '12', channel_id: '34', message_id: '999' },
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ message_id: id, channel_id: '34' }) }] } }), f), 1);
  }
  assert.equal(readManualLedger(f.file).entries.length, 6);
  assert.ok(readManualLedger(f.file).entries.every(e => e.discord.messageId !== '999'));
});
test('kim recipients excluded; channel requests and Unicode subjects supported', t => {
  const f = fixture(t);
  assert.equal(registerHook(input({ tool_input: { content: 'お願いします', user_id: '715210673642012733' } }), f), 0);
  assert.equal(registerHook(input({ tool_response: { message_id: '1', channel_id: '1508437329247862794' } }), f), 0);
  assert.equal(registerHook(input({ tool_name: 'mcp__claude_ai_Discord__send_message',
    tool_input: { channel_id: '34', content: 'お願い' + '😀'.repeat(80) }, tool_response: { message_id: '2' } }), f), 1);
  const row = readManualLedger(f.file).entries[0];
  assert.equal(row.who, '34'); assert.equal(Array.from(row.subject).length, 60);
});
test('manual CLI schema accepts Discord and rejects unsupported channels', () => {
  const options = { who: '12', subject: 'request', sent: '2026-10-26', channel: 'Discord' };
  assert.equal(addManual({ entries: [] }, options).channel, 'Discord');
  assert.throws(() => addManual({ entries: [] }, { ...options, channel: 'other' }));
});
test('registrar installs the exact matcher and setup checks exist', () => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const hooks = repositoryHooks(repo, os.tmpdir()).PostToolUse;
  assert.equal(hooks.filter(g => g.matcher === MATCHER && g.hooks[0].command.includes('discord-ask-register-hook.mjs')).length, 1);
  const manifest = fs.readFileSync(new URL('./setup-manifest.json', import.meta.url), 'utf8');
  assert.match(manifest, /settings:discord-ask-register/);
});
test('concurrent hook processes preserve distinct entries and deduplicate', async t => {
  const f = fixture(t);
  const run = id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./discord-ask-register-hook.mjs', import.meta.url))],
      { env: { ...process.env, ORGIAST_HOME: f.home }, stdio: ['pipe', 'ignore', 'pipe'] });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    child.stdin.end(JSON.stringify(input({ tool_response: { message_id: id, channel_id: '34' } })));
  });
  await Promise.all(['11', '12', '11', '13'].map(run));
  assert.equal(readManualLedger(f.file).entries.length, 3);
});
function overdue(f) {
  registerDiscord({ channelId: '34', messageId: '56', userId: '12', subject: 'ご確認ください', sent: '2026-10-26', session: 's' }, f);
}
test('overdue Discord rows show without kim items, once per 24h across sessions and events', t => {
  const f = fixture(t); overdue(f);
  const options = { ...f, env: {}, collect: () => [] };
  const text = context({ session_id: 'a', hook_event_name: 'SessionStart' }, options).hookSpecificOutput.additionalContext;
  assert.match(text, /【必須】Discord 返事待ち 1 件/);
  assert.match(text, /（10日）/);
  assert.match(text, /list_messages channel_id=34 after=56/);
  assert.match(text, /--done 12-20261026/);
  assert.equal(context({ session_id: 'b', hook_event_name: 'SessionStart' }, options), null);
  assert.equal(context({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, { ...options, now: NOW + 86399999 }), null);
  assert.ok(context({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, { ...options, now: NOW + 86400000 }));
});
test('fresh, done and other channels do not show; unattended does not consume reminder', t => {
  const f = fixture(t); overdue(f);
  const options = { ...f, env: {}, collect: () => [] };
  assert.equal(context({ session_id: 'a' }, { ...options, env: { CLAUDE_HEADLESS: '1' } }), null);
  const ledger = readManualLedger(f.file);
  for (const change of [{ sentAt: '2026-11-04' }, { status: 'done' }, { channel: 'メール' }]) {
    fs.writeFileSync(f.file, JSON.stringify({ entries: [{ ...ledger.entries[0], ...change }] }));
    assert.equal(context({ session_id: 'a' }, options), null);
  }
  fs.writeFileSync(f.file, JSON.stringify(ledger));
  assert.ok(context({ session_id: 'a' }, options));
});
test('kim three-hour suppression cannot hide newly overdue Discord rows', t => {
  const f = fixture(t);
  const options = { ...f, env: {}, collect: () => [] };
  assert.equal(context({ session_id: 'a' }, options), null);
  overdue(f);
  assert.ok(context({ session_id: 'a' }, options));
});

test('abandoned locks recover after interrupted hooks', t => {
  const f = fixture(t);
  fs.mkdirSync(`${f.file}.lock`, { recursive: true });
  const old = new Date(Date.now() - 600000);
  fs.utimesSync(`${f.file}.lock`, old, old);
  overdue(f);
  const lock = path.join(f.home, '.claude', 'discord-reply-waiting-shown.json.lock');
  fs.mkdirSync(lock); fs.utimesSync(lock, old, old);
  assert.ok(context({ session_id: 'a' }, { ...f, env: {}, collect: () => [] }));
});
