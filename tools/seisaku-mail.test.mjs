import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCli } from './seisaku-mail.mjs';

function fixture(t, { artifact = true, result = { ok: true, threadId: 't1', messageId: 'm1' }, log, pending = false, never = false, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'seisaku-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const body = join(home, 'body.txt');
  writeFileSync(body, 'こんにちは\nsecond\nthird\nfourth');
  mkdirSync(join(home, '.gh-device'));
  writeFileSync(join(home, '.gh-device', 'token.txt'), '  secret-test-token\n');
  let time = Date.parse('2026-10-28T01:00:00.300Z'), polls = 0, output = '', downloaded;
  const calls = [], sleeps = [];
  const runInfo = status => ({ id: 42, created_at: '2026-10-28T01:00:01Z', status });
  const run = createCli({ home, env, now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; }, stdout: s => { output += s; }, spawnSync: (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    assert.equal(cmd, 'gh');
    assert.equal(opts.shell, false);
    assert.equal(opts.windowsHide, true);
    const success = value => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value) });
    if (args[0] === 'workflow') return success('');
    if (args[0] === 'api' && args[1].includes('/workflows/')) {
      polls++;
      return success({ workflow_runs: never || (pending && polls === 1) ? [{ id: 1, created_at: '2026-10-27T00:00:00Z', status: 'completed' }] : [runInfo(pending ? 'in_progress' : 'completed')] });
    }
    if (args[0] === 'api') return success(runInfo('completed'));
    if (args[1] === 'download') {
      downloaded = args.at(-1);
      if (!artifact) return { status: 1, stderr: 'missing' };
      writeFileSync(join(downloaded, 'result.json'), JSON.stringify(result));
      return success('');
    }
    if (args[1] === 'view') return success(log ?? 'job\tstep\t2026-10-28T01:00:02Z {"ok":true,"draftId":"d1"}\n');
    assert.fail(`Unexpected gh call: ${args}`);
  } });
  return { run, calls, sleeps, body, output: () => output, downloaded: () => downloaded };
}
const writeArgs = (f, action = 'draft') => [action, '--to', 'info@example.com', '--subject', '件名', '--body-file', f.body, '--json'];

test('draft dispatch encodes UTF-8 body and accepts Drive attachments', async t => {
  const f = fixture(t);
  assert.equal(await f.run([...writeArgs(f), '--attach-drive', 'a,b', '--cc', 'cc@example.com', '--reply-to-thread-of', 'reply@example.com']), 0);
  const args = f.calls[0].args;
  for (const input of ['to=info@example.com', 'mode=draft', 'attachment_drive_ids=a,b', 'cc=cc@example.com', 'reply_to_thread_of=reply@example.com', `body_b64=${Buffer.from('こんにちは\nsecond\nthird\nfourth').toString('base64')}`]) {
    const index = args.indexOf(input); assert.ok(index > 0); assert.equal(args[index - 1], '-f');
  }
  assert.equal(args[2], 'seisaku-mail.yml');
  assert.equal(JSON.parse(f.output()).messageId, 'm1');
  assert.equal(existsSync(f.downloaded()), false);
});

test('send preview exits 64 before any gh call; --yes dispatches send', async t => {
  const f = fixture(t);
  assert.equal(await f.run([...writeArgs(f, 'send'), '--attach-drive', 'a,b']), 64);
  assert.equal(f.calls.length, 0);
  const preview = JSON.parse(f.output());
  assert.equal(preview.preview, 'こんにちは\nsecond\nthird');
  assert.equal(preview.attachmentDriveIds, 'a,b');
  assert.equal(preview.subject, '件名');
  const approved = fixture(t);
  assert.equal(await approved.run([...writeArgs(approved, 'send'), '--yes']), 0);
  assert.ok(approved.calls[0].args.includes('mode=send'));
});

test('polls every five seconds, ignores old runs and waits for completion', async t => {
  const f = fixture(t, { pending: true });
  assert.equal(await f.run(writeArgs(f)), 0);
  assert.deepEqual(f.sleeps, [5000, 5000]);
  assert.ok(f.calls.some(c => c.args[1] === 'repos/kimkon1011/aujust-sales-automation/actions/runs/42'));
});

test('missing artifact falls back to prefixed log JSON', async t => {
  const f = fixture(t, { artifact: false });
  assert.equal(await f.run(writeArgs(f)), 0);
  assert.equal(JSON.parse(f.output()).draftId, 'd1');
});

test('missing result is exit 1 with runUrl', async t => {
  const f = fixture(t, { artifact: false, log: 'no result' });
  assert.equal(await f.run(writeArgs(f)), 1);
  assert.deepEqual(JSON.parse(f.output()), { ok: false, error: 'result not found', runUrl: 'https://github.com/kimkon1011/aujust-sales-automation/actions/runs/42' });
});

for (const [action, args, expected] of [
  ['search', ['--query', 'is:unread', '--max', '7', '--user', 'other@orgiast.jp'], ['query=is:unread', 'max=7', 'user=other@orgiast.jp']],
  ['drafts', [], ['user=seisaku-team@orgiast.jp']],
  ['delete-draft', ['--id', 'd1'], ['id=d1']],
  ['thread', ['--id', 't1'], ['id=t1']],
  ['message', ['--id', 'm1'], ['id=m1']],
]) test(`${action} dispatches read workflow with inputs`, async t => {
  const f = fixture(t);
  assert.equal(await f.run([action, ...args, '--json']), 0);
  assert.equal(f.calls[0].args[2], 'seisaku-mail-read.yml');
  for (const value of [`action=${action}`, ...expected]) assert.ok(f.calls[0].args.includes(value));
  assert.ok(f.calls.find(c => c.args[1] === 'download').args.includes('seisaku-mail-read-result'));
});

test('token file is trimmed, supplied only in environment and redacted from output', async t => {
  const f = fixture(t, { result: { ok: false, error: 'secret-test-token' } });
  assert.equal(await f.run(writeArgs(f)), 1);
  assert.equal(f.calls[0].opts.env.GH_TOKEN, 'secret-test-token');
  assert.ok(!JSON.stringify(f.calls.map(c => c.args)).includes('secret-test-token'));
  assert.ok(!f.output().includes('secret-test-token'));
});

test('environment token and repository take precedence', async t => {
  const f = fixture(t, { env: { GH_TOKEN: 'env-token', SEISAKU_MAIL_REPO: 'owner/repo' } });
  assert.equal(await f.run(writeArgs(f)), 0);
  assert.equal(f.calls[0].opts.env.GH_TOKEN, 'env-token');
  assert.ok(f.calls[0].args.includes('owner/repo'));
});

test('timeout returns 2 without downloading results', async t => {
  const f = fixture(t, { never: true });
  assert.equal(await f.run([...writeArgs(f), '--wait', '6']), 2);
  assert.deepEqual(f.sleeps, [5000, 1000]);
  assert.equal(JSON.parse(f.output()).error, 'wait timeout');
  assert.ok(!f.calls.some(c => c.args[1] === 'download'));
});

test('invalid arguments and header newlines return 64 before gh', async t => {
  for (const args of [[], ['search'], ['thread'], ['drafts', '--wat'], ['drafts', '--wait', 'NaN'], ['search', '--query', 'a', '--max', '0']]) {
    const f = fixture(t); assert.equal(await f.run(args), 64); assert.equal(f.calls.length, 0);
  }
  for (const flag of ['--to', '--subject', '--cc', '--reply-to-thread-of']) {
    const f = fixture(t);
    const args = writeArgs(f);
    const index = args.indexOf(flag);
    if (index >= 0) args[index + 1] = 'bad\ninjection'; else args.push(flag, 'bad\rinjection');
    assert.equal(await f.run(args), 64); assert.equal(f.calls.length, 0);
  }
});
