import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLf, sha1Lf, isUnchanged, buildManifest, pushHub, tokyoDate, FOLDERS } from './hub-push.mjs';

const template = { title: 'CLAUDE.md.template', in: 'hub', localTarget: '~/.claude/CLAUDE.md', extra: 'keep' };
const prev = { version: 7, updatedAt: '2026-07-06', files: [template,
  { title: 'a.md', in: 'rules', localTarget: '/custom/a.md' }], other: 'preserved' };
const target = { title: 'a.md', in: 'rules', content: 'hello\r\n' };

test('CRLF -> LF, LF unchanged; hashes use normalized content', () => {
  assert.equal(normalizeLf(Buffer.from('a\r\nb\r\n')), 'a\nb\n');
  assert.equal(normalizeLf('a\nb\n'), 'a\nb\n');
  assert.equal(sha1Lf('hello\r\n'), sha1Lf('hello\n'));
  assert.match(sha1Lf('hello\n'), /^[a-f0-9]{40}$/);
  assert.ok(isUnchanged('hello\r\n', 'hello\n'));
  assert.equal(isUnchanged('hello\n', 'changed\n'), false);
});

test('manifest increments only on changes and preserves metadata and hub-only entries', () => {
  assert.equal(buildManifest(prev, [target], '2026-09-23', false), prev);
  const next = buildManifest(prev, [target], '2026-09-23', true);
  assert.equal(next.version, 8);
  assert.equal(next.updatedAt, '2026-09-23');
  assert.equal(next.other, 'preserved');
  assert.deepEqual(next.files.find((f) => f.title === template.title), template);
  assert.equal(next.files[0].localTarget, '/custom/a.md');
  assert.equal(next.files[0].sha1, sha1Lf(target.content));
  assert.equal(prev.version, 7);
});

test('manifest generates missing localTarget values and inherits by title', () => {
  const files = [target, { title: 's.md', in: 'skills', content: '' }, { title: 'ONBOARDING.md', in: 'hub', content: '' }];
  const next = buildManifest({ version: '3', files: [] }, files, '2026-09-23', true);
  assert.equal(next.version, 4);
  assert.deepEqual(next.files.map((f) => f.localTarget), ['~/.claude/rules/a.md', '~/.claude/skills/s/SKILL.md', '~/.claude/ONBOARDING.md']);
  assert.equal(buildManifest({ version: 1, files: [{ title: 'a.md', localTarget: '/old' }] }, [target], '', true).files[0].localTarget, '/old');
});

test('execution date uses Asia/Tokyo', () => {
  assert.equal(tokyoDate(new Date('2026-09-22T15:00:00Z')), '2026-09-23');
});

function mockDrive({ content = 'old\n', missing = false, duplicates = false, fail = false } = {}) {
  const calls = [], logs = [], warnings = [];
  const request = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    const u = new URL(url);
    if (opts.method) {
      if (fail) throw new Error('simulated upload failure');
      return { json: async () => ({ id: 'created' }) };
    }
    if (u.searchParams.has('q')) {
      if (u.searchParams.get('q').includes("name='manifest.json'")) {
        return { json: async () => ({ files: [{ id: 'manifest', modifiedTime: '2026-01-01' }] }) };
      }
      if (missing) return { json: async () => ({ files: [] }) };
      if (duplicates && !u.searchParams.has('pageToken')) {
        return { json: async () => ({ files: [{ id: 'older', modifiedTime: '2025-01-01' }], nextPageToken: 'page2' }) };
      }
      return { json: async () => ({ files: [{ id: 'latest', modifiedTime: '2026-09-01' }] }) };
    }
    return { text: async () => u.pathname.endsWith('/manifest') ? JSON.stringify(prev) : content };
  };
  return { calls, logs, warnings, options: { targets: [target], request, today: '2026-09-23', log: (s) => logs.push(s), warn: (s) => warnings.push(s) } };
}

test('regression: CRLF-only difference is unchanged; no upload or manifest write', async () => {
  const m = mockDrive({ content: 'hello\n' });
  const result = await pushHub(m.options);
  assert.equal(result.unchanged, 1);
  assert.equal(result.newVersion, 7);
  assert.equal(m.calls.filter((c) => c.method).length, 0);
  assert.equal(m.logs.at(-1), 'hub-push: uploaded=0 unchanged=1 created=0 version=7->7');
});

test('PATCH retains newest ID across pages, warns, normalizes body and updates manifest once', async () => {
  const m = mockDrive({ duplicates: true });
  const result = await pushHub(m.options);
  const writes = m.calls.filter((c) => c.method);
  assert.equal(writes.length, 2);
  assert.match(writes[0].url, /\/latest\?uploadType=media$/);
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].body, 'hello\n');
  assert.equal(writes[0].headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(JSON.parse(writes[1].body).version, 8);
  assert.equal(m.warnings.length, 1);
  assert.equal(result.uploaded, 1);
});

test('missing target uses multipart create with correct parent and LF payload', async () => {
  const m = mockDrive({ missing: true });
  const result = await pushHub(m.options);
  const write = m.calls.find((c) => c.method);
  assert.equal(write.method, 'POST');
  assert.match(write.url, /uploadType=multipart/);
  assert.ok(write.body.includes(FOLDERS.rules));
  assert.ok(write.body.includes('\r\n\r\nhello\n\r\n--'));
  assert.equal(result.created, 1);
  assert.equal(result.uploaded, 0);
});

test('dry-run lists planned changes and version, never writes (including creates)', async () => {
  for (const missing of [false, true]) {
    const m = mockDrive({ missing });
    const result = await pushHub({ ...m.options, dryRun: true });
    assert.equal(m.calls.filter((c) => c.method).length, 0);
    assert.ok(m.logs.some((s) => s.includes(`would ${missing ? 'create' : 'update'}: rules/a.md`)));
    assert.ok(m.logs.some((s) => s.includes('version=7->8')));
    assert.equal(result.newVersion, 7);
    assert.equal(result.uploaded + result.created, 0);
  }
});

test('upload errors name the file and do not publish manifest', async () => {
  const m = mockDrive({ fail: true });
  await assert.rejects(pushHub(m.options), /rules\/a.md: simulated upload failure/);
  assert.equal(m.calls.filter((c) => c.method).length, 1);
  assert.match(m.logs.at(-1), /^hub-push: uploaded=0/);
});

test('remote read failure prevents all writes', async () => {
  const m = mockDrive();
  await assert.rejects(pushHub({ ...m.options, targets: [target, { title: 'bad.md', in: 'rules', content: '' }],
    request: async (url, opts) => {
      if (new URL(url).searchParams.get('q')?.includes("name='bad.md'")) throw new Error('read failed');
      return m.options.request(url, opts);
    },
  }), /bad.md: read failed/);
  assert.equal(m.calls.filter((c) => c.method).length, 0);
});
