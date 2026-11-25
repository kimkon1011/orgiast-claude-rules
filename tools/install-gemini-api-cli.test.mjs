import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { appendPath, assetName, installGeminiApiCli } from './install-gemini-api-cli.mjs';

const secret = 'DUMMY_GEMINI_KEY_FOR_TESTS_ONLY';
function fixture(overrides = {}) {
  const files = new Map();
  const writes = [];
  const calls = [];
  const archive = Buffer.from('archive');
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  const release = { tag_name: 'v0.5.0', assets: [
    { name: 'gemini-api_Linux_x86_64.tar.gz', browser_download_url: 'https://download/cli' },
    { name: 'checksums.txt', browser_download_url: 'https://download/checksums' },
  ] };
  const fetchImpl = async url => {
    if (url.includes('/releases/latest')) return { ok: true, json: async () => release };
    const body = url.endsWith('checksums') ? Buffer.from(`${digest}  gemini-api_Linux_x86_64.tar.gz\n`) : archive;
    return { ok: true, arrayBuffer: async () => body };
  };
  const exists = file => files.has(file) || file.endsWith('/skills/gemini-api-cli/SKILL.md');
  const options = {
    home: '/home/test', platform: 'linux', arch: 'x64', env: { PATH: '/usr/bin' }, fetchImpl,
    exists, read: file => files.get(file) ?? '', readBuffer: file => Buffer.from(files.get(file) ?? ''),
    write: (file, value) => { files.set(file, value); writes.push([file, value]); }, mkdir: () => {}, copy: (from, to) => files.set(to, files.get(from) || 'binary'),
    rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); }, rm: file => files.delete(file), chmod: () => {},
    mkdtemp: () => '/tmp/gemini-api-test', readdir: dir => dir.endsWith('/extract') ? ['gemini-api'] : [], stat: () => ({ isDirectory: () => false }),
    spawnImpl: (exe, args, opts) => { calls.push({ exe, args, opts }); if (args[0] === 'whoami') return { status: 0, stdout: '{"auth":{"source":"keychain"}}', stderr: '' }; if (args.join(' ') === 'configure --help') return { status: 0, stdout: '--api-key string\n--no-interactive', stderr: '' }; return { status: 0, stdout: '', stderr: '' }; },
    log: () => {}, now: () => new Date('2026-11-25T00:00:00.000Z'), ...overrides,
  };
  return { files, writes, calls, archive, digest, release, options };
}

test('selects release asset names for supported platforms and architectures', () => {
  assert.equal(assetName('win32', 'x64'), 'gemini-api_Windows_x86_64.zip');
  assert.equal(assetName('win32', 'arm64'), 'gemini-api_Windows_arm64.zip');
  assert.equal(assetName('linux', 'x64'), 'gemini-api_Linux_x86_64.tar.gz');
  assert.equal(assetName('darwin', 'arm64'), 'gemini-api_Darwin_arm64.tar.gz');
  assert.throws(() => assetName('freebsd', 'x64'), /Unsupported/);
});

test('checksum mismatch stops before extraction and binary installation', async () => {
  const f = fixture({ fetchImpl: async url => url.includes('/releases/latest') ? { ok: true, json: async () => fixture().release } : { ok: true, arrayBuffer: async () => Buffer.from(url.endsWith('checksums') ? `${'0'.repeat(64)}  gemini-api_Linux_x86_64.tar.gz\n` : 'archive') } });
  const result = await installGeminiApiCli(f.options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Checksum mismatch/);
  assert.equal(f.calls.some(call => call.exe === 'tar'), false);
});

test('PATH append is idempotent and preserves existing entries and order', () => {
  assert.equal(appendPath('C:\\A;C:\\B', 'C:\\Tools', 'win32'), 'C:\\A;C:\\B;C:\\Tools');
  assert.equal(appendPath('C:\\A;C:\\Tools;C:\\B', 'c:\\tools\\', 'win32'), 'C:\\A;C:\\Tools;C:\\B');
  assert.equal(appendPath('/usr/bin:/home/test/.local/bin', '/home/test/.local/bin', 'linux'), '/usr/bin:/home/test/.local/bin');
});

test('API key is redacted from result, marker, errors, and logs', async () => {
  const logs = [];
  const f = fixture({ log: value => logs.push(value) });
  f.files.set('/home/test/.gemini/.env', `GEMINI_API_KEY=${secret}\n`);
  let whoami = 0;
  f.options.spawnImpl = (exe, args, opts) => {
    f.calls.push({ exe, args, opts });
    if (args[0] === 'whoami') return ++whoami === 1 ? { status: 3, stderr: `missing ${secret}` } : { status: 0, stdout: '{"source":"keychain"}' };
    if (args.join(' ') === 'configure --help') return { status: 0, stdout: '--api-key string\n--no-interactive', stderr: '' };
    if (args[0] === 'configure') return { status: 1, stderr: `rejected ${secret}` };
    return { status: 0, stdout: '' };
  };
  const result = await installGeminiApiCli(f.options);
  const marker = f.files.get('/home/test/.claude/.gemini-api-cli-installed.json');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(String(marker).includes(secret), false);
  assert.equal(logs.join('\n').includes(secret), false);
  assert.equal(result.errors.join('\n').includes('***'), true);
  const configure = f.calls.find(call => call.args[0] === 'configure' && call.args.includes('--api-key'));
  assert.deepEqual(configure.args.slice(0, 2), ['configure', '--api-key']);
  assert.equal(configure.args.includes('--no-interactive'), true);
  assert.equal(configure.opts.stdio.join(','), 'ignore,pipe,pipe');
});

test('fresh checkedAt skips GitHub fetch and spawn', async () => {
  let fetched = 0, spawned = 0;
  const f = fixture({ fetchImpl: async () => { fetched++; throw new Error('must not fetch'); }, spawnImpl: () => { spawned++; throw new Error('must not spawn'); } });
  f.files.set('/home/test/.claude/.gemini-api-cli-installed.json', JSON.stringify({ ok: true, version: '0.5.0', checkedAt: '2026-11-24T12:00:01.000Z' }));
  const result = await installGeminiApiCli(f.options);
  assert.equal(result.skipped, 'checked-within-24h');
  assert.equal(result.exitCode, 0); assert.equal(fetched, 0); assert.equal(spawned, 0);
});

test('missing .env continues with keyStored false', async () => {
  const f = fixture();
  f.options.spawnImpl = (exe, args, opts) => { f.calls.push({ exe, args, opts }); if (args[0] === 'whoami') return { status: 3, stdout: '', stderr: 'not configured' }; return { status: 0, stdout: '' }; };
  const result = await installGeminiApiCli(f.options);
  assert.equal(result.keyStored, false);
  assert.equal(result.errors.some(value => value.startsWith('auth:')), false);
  assert.equal(f.calls.some(call => call.args[0] === 'configure'), false);
});

test('dry-run returns a plan without network, spawn, or writes', async () => {
  const f = fixture({ fetchImpl: async () => { throw new Error('network called'); }, spawnImpl: () => { throw new Error('spawn called'); } });
  const result = await installGeminiApiCli({ ...f.options, dryRun: true });
  assert.equal(result.exitCode, 0); assert.equal(result.dryRun, true); assert.ok(result.plan.length >= 6); assert.equal(f.writes.length, 0);
});
