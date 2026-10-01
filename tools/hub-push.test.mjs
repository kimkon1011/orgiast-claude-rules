import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLf, sha1Lf, isUnchanged, buildManifest, pushHub, collectTargets, tokyoDate } from './hub-push.mjs';

const prev = { version: 7, updatedAt: '2026-09-01', note: 'preserve', files: [
  { title: 'CLAUDE.md.template', in: 'hub', localTarget: '~/.claude/CLAUDE.md', extra: true },
  { title: 'a.md', in: 'rules', localTarget: '/custom/a.md' },
] };
const target = { title: 'a.md', in: 'rules', content: 'hello\r\n' };

test('CRLF becomes LF; LF and lone CR are unchanged; SHA1 hashes normalized UTF-8', () => {
  assert.equal(normalizeLf(Buffer.from('日本語\r\na\rb\n')), '日本語\na\rb\n');
  assert.equal(normalizeLf('hello\n'), 'hello\n');
  assert.equal(sha1Lf('hello\r\n'), 'f572d396fae9206628714fb2ce00f72e94f2258f');
  assert.ok(isUnchanged('hello\n', 'hello\r\n'));
  assert.ok(!isUnchanged('new\n', 'old\n'));
});

test('manifest increments only with writes; retains hub entries, paths and metadata', () => {
  const unchanged = [{ ...target, status: 'unchanged' }];
  assert.deepEqual(buildManifest(prev, unchanged, '2026-10-01'), prev);
  const next = buildManifest(prev, [
    { ...target, status: 'uploaded' },
    { title: 'b.md', in: 'rules', content: 'b', status: 'created' },
    { title: 'demo.md', in: 'skills', content: 'demo', status: 'unchanged' },
    { title: 'ONBOARDING.md', in: 'hub', content: 'start', status: 'unchanged' },
  ], '2026-10-01');
  assert.equal(next.version, 8);
  assert.equal(next.updatedAt, '2026-10-01');
  assert.equal(next.note, 'preserve');
  assert.deepEqual(next.files.at(-1), prev.files[0]);
  assert.deepEqual(next.files.slice(0, 4).map((f) => f.localTarget), [
    '/custom/a.md', '~/.claude/rules/b.md', '~/.claude/skills/demo/SKILL.md', '~/.claude/ONBOARDING.md',
  ]);
  assert.equal(next.files[0].sha1, sha1Lf(target.content));
  assert.equal(prev.version, 7);
});

test('Tokyo execution date rolls over at 15:00 UTC', () => {
  assert.equal(tokyoDate(new Date('2026-09-30T15:00:00Z')), '2026-10-01');
});

function fakeDrive({ content = 'old\n', missing = false, duplicates = false, fail = '', manifest = prev } = {}) {
  const calls = [];
  const apiFn = async (token, url, opts = {}) => {
    assert.equal(token, 'test-token');
    calls.push({ url, ...opts });
    const u = new URL(url);
    if (opts.method) {
      if (fail && u.pathname.includes(fail)) throw new Error('simulated write failure');
      return { json: async () => ({ id: 'created-id' }) };
    }
    if (u.searchParams.has('q')) {
      const isManifest = u.searchParams.get('q').includes("name='manifest.json'");
      if (isManifest) return { json: async () => ({ files: [{ id: 'manifest', modifiedTime: '2026-09-01' }] }) };
      if (missing) return { json: async () => ({ files: [] }) };
      if (duplicates && !u.searchParams.has('pageToken')) return { json: async () => ({
        files: [{ id: 'older', modifiedTime: '2026-08-01' }], nextPageToken: 'page2',
      }) };
      return { json: async () => ({ files: [{ id: 'latest', modifiedTime: '2026-09-01' }] }) };
    }
    assert.equal(u.searchParams.get('alt'), 'media');
    return { text: async () => u.pathname.endsWith('/manifest') ? JSON.stringify(manifest) : content };
  };
  return { apiFn, calls };
}

async function run(options = {}, overrides = {}) {
  const fake = fakeDrive(options);
  const logs = [], warnings = [];
  const stats = await pushHub({ targets: [target], token: 'test-token', apiFn: fake.apiFn,
    today: '2026-10-01', log: (line) => logs.push(line), warn: (line) => warnings.push(line), ...overrides });
  return { ...fake, logs, warnings, stats, writes: fake.calls.filter((call) => call.method) };
}

test('regression: CRLF-only differences are unchanged and do not rotate manifest', async () => {
  const result = await run({ content: 'hello\n' });
  assert.equal(result.writes.length, 0);
  assert.deepEqual(result.stats, { uploaded: 0, unchanged: 1, created: 0 });
  assert.equal(result.logs.at(-1), 'hub-push: uploaded=0 unchanged=1 created=0 version=7->7');
});

test('updates retain latest fileId, normalize payload, warn on duplicates across pages', async () => {
  const result = await run({ duplicates: true });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /a\.md.*duplicates/);
  assert.equal(result.writes.length, 2);
  const [file, manifest] = result.writes;
  assert.match(file.url, /\/latest\?uploadType=media$/);
  assert.equal(file.method, 'PATCH');
  assert.equal(file.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(file.body, 'hello\n');
  assert.equal(JSON.parse(manifest.body).version, 8);
  assert.equal(JSON.parse(manifest.body).files[0].sha1, sha1Lf('hello\n'));
  assert.equal(result.logs.at(-1), 'hub-push: uploaded=1 unchanged=0 created=0 version=7->8');
});

test('missing targets use multipart create with parent and normalized content', async () => {
  const result = await run({ missing: true });
  assert.equal(result.writes[0].method, 'POST');
  assert.match(result.writes[0].url, /uploadType=multipart/);
  assert.match(result.writes[0].body, /"name":"a.md","parents":\["1cNOSlo8pcrhXiRMRK_WD3O5IW-K9lYX4"\]/);
  assert.ok(result.writes[0].body.includes('hello\n\r\n--'));
  assert.equal(result.stats.created, 1);
  assert.equal(result.stats.uploaded, 1);
});

test('dry-run lists planned updates and creates without any write', async () => {
  for (const missing of [false, true]) {
    const result = await run({ missing }, { dryRun: true });
    assert.equal(result.writes.length, 0);
    assert.ok(result.logs.includes(`[dry-run] ${missing ? 'create' : 'update'}: rules/a.md`));
    assert.equal(result.logs.at(-1), 'hub-push: uploaded=0 unchanged=0 created=0 version=7->7');
  }
});

test('write errors identify the file and never publish a success manifest', async () => {
  const fake = fakeDrive({ fail: '/latest' });
  await assert.rejects(pushHub({ targets: [target], token: 'test-token', apiFn: fake.apiFn, log: () => {} }), /rules\/a.md: simulated write failure/);
  assert.equal(fake.calls.filter((c) => c.method).length, 1);
  await assert.rejects(run({ fail: '/manifest' }), /manifest.json: simulated write failure/);
});

test('invalid manifest aborts before writes', async () => {
  await assert.rejects(run({ manifest: { version: '7', files: [] } }), /manifest.json: invalid/);
});

test('collects all rule markdown and skill entry points, including onboarding', () => {
  const repo = mkdtempSync(join(tmpdir(), 'hub-push-test-'));
  try {
    mkdirSync(join(repo, 'rules'));
    mkdirSync(join(repo, 'skills', 'demo'), { recursive: true });
    mkdirSync(join(repo, 'skills', 'empty'));
    writeFileSync(join(repo, 'ONBOARDING.md'), 'start\r\n');
    writeFileSync(join(repo, 'rules', 'a.md'), 'a');
    writeFileSync(join(repo, 'rules', 'ignore.txt'), 'ignore');
    writeFileSync(join(repo, 'skills', 'demo', 'SKILL.md'), 'demo');
    const files = collectTargets(repo, join(repo, 'ONBOARDING.md'));
    assert.deepEqual(files.map((f) => f.title), ['ONBOARDING.md', 'a.md', 'demo.md']);
    assert.equal(files[0].content, 'start\n');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('registration preserves the deployed hidden task, working directory and schedule', () => {
  const script = readFileSync(new URL('./register-hub-push-task.ps1', import.meta.url), 'utf8');
  assert.match(script, /New-HiddenScheduledTaskAction.*-WorkingDirectory \$repo/);
  assert.match(script, /-TaskName 'OrgiastHubPush'.*-Force/);
  assert.match(script, /-Daily -At '02:40'/);
  assert.match(script, /Resolve-RegisterRepoRoot/);
});
