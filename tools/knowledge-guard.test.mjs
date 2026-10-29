import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { protectedTarget, runHook, sessionStart } from './knowledge-guard.mjs';
import { main, canonicalVerdict } from './knowledge-lock.mjs';

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const now = Date.now(), seconds = Math.floor(now / 1000);
function signed(overrides = {}) {
  const verdict = { email: 'user@example.test', orgUuid: '', contracted: true, reason: 'active_email', pcId: 'test-PC', iat: seconds - 60, exp: seconds + 3600, ...overrides };
  return { verdict, sig: crypto.sign('sha256', Buffer.from(canonicalVerdict(verdict)), {
    key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
  }).toString('base64url') };
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); fs.writeFileSync(path.join(home, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  write('knowledge-lock-pubkey.pem', pair.publicKey);
  write('.claude.json', { oauthAccount: { emailAddress: 'user@example.test' } });
  write('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'secret-oauth' } });
  write('claude-account-ledger.json', { version: 1, members: [], contractedOrgUuids: [] });
  const f = { home, write, output: '', calls: 0, notifications: [] };
  f.deps = { home, toolsDir: home, now: () => now,
    env: { ORGIAST_KEYSERVE_SECRET: 'secret-hmac', ORGIAST_KEYSERVE_PC: 'test-PC' },
    stdout: text => { f.output += text; }, stderr: text => { f.output += text; },
    fetch: async () => { f.calls++; throw Error('secret-oauth'); },
    spawn: (...args) => { f.notifications.push(args); return new EventEmitter(); },
  };
  f.cache = value => write('.claude/state/knowledge-verdict.json', value);
  f.hook = () => runHook({ tool_name: 'Read', tool_input: { file_path: path.join(home, '.claude/projects/secret.md') } }, f.deps);
  f.log = () => fs.readFileSync(path.join(home, '.claude/logs/knowledge-guard.log'), 'utf8');
  return f;
}

test('保護パス: Windows/POSIX、大文字小文字、相対パス、ツールとlock除外', () => {
  for (const home of ['/home/kim', 'C:\\Users\\Kim']) {
    for (const suffix of ['/.claude/projects/x/memory/MEMORY.md', '/.claude/projects/a.jsonl', '/.claude/shared-memory/a.md', '/.claude/next-session-2.md', '/.claude/handoff-x/nested/a.md']) {
      for (const file of [home + suffix, (home + suffix).toUpperCase().replaceAll('/', '\\')]) {
        for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
          const input = tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file };
          assert.ok(protectedTarget({ tool_name: tool, tool_input: input }, home), file);
          assert.equal(protectedTarget({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: file + '.lock' } : { file_path: file + '.lock' } }, home), null);
        }
      }
    }
    assert.ok(protectedTarget({ tool_name: 'Read', cwd: home + '/.claude', tool_input: { file_path: 'projects/x.md' } }, home));
  }
  for (const file of ['/repo/HANDOVER.md', 'D:\\repo\\handover.md']) assert.ok(protectedTarget({ tool_name: 'Read', tool_input: { file_path: file } }));
  for (const command of ['cat ~/.claude/projects/x', 'type C:\\Users\\Kim\\.claude\\projects\\x', 'cat shared-memory/x', 'cat next-session.md', 'cat HANDOVER.md', 'cat x.jsonl']) {
    for (const tool_name of ['Bash', 'PowerShell']) assert.ok(protectedTarget({ tool_name, tool_input: { command } }));
  }
  for (const command of ['cat HANDOVER.md.lock', 'cat next-session.md.lock', 'echo hello']) assert.equal(protectedTarget({ tool_name: 'Bash', tool_input: { command } }), null);
  assert.ok(protectedTarget({ tool_name: 'Bash', tool_input: { command: 'cat HANDOVER.md.lock; cat HANDOVER.md' } }));
  for (const tool_name of ['Grep', 'Glob']) {
    assert.ok(protectedTarget({ tool_name, cwd: '/home/kim/.claude/projects', tool_input: { pattern: '*' } }, '/home/kim'));
    assert.ok(protectedTarget({ tool_name, cwd: '/repo', tool_input: { pattern: '**/HANDOVER.md' } }));
    assert.equal(protectedTarget({ tool_name, cwd: '/repo', tool_input: { pattern: 'hello', glob: '*.js' } }), null);
    assert.equal(protectedTarget({ tool_name, cwd: '/home/kim/.claude/projects', tool_input: { pattern: '*.lock', glob: '*.lock' } }, '/home/kim'), null);
  }
});
test('公開鍵なし、非保護パスはネットワーク不要', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.home, 'knowledge-lock-pubkey.pem'));
  assert.equal((await f.hook()).allow, true);
  assert.equal((await runHook({ tool_name: 'Read', tool_input: { file_path: '/repo/main.js' } }, f.deps)).allow, true);
  assert.equal(f.calls, 0);
});
test('署名済み契約/契約外キャッシュ、拒否JSONとパスの非記録', async t => {
  const f = fixture(t);
  f.cache(signed());
  assert.equal((await f.hook()).allow, true);
  f.cache(signed({ contracted: false, reason: 'not_in_ledger' }));
  assert.equal((await f.hook()).allow, false);
  assert.equal(JSON.parse(f.output).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(f.output, /オージャスト契約外/);
  assert.equal(f.calls, 0);
  assert.ok(!f.log().includes('secret.md'));
  assert.ok(!f.log().includes('secret-oauth'));
});
test('署名改ざんは再判定してキャッシュを更新、email/PC不一致も拒否', async t => {
  const f = fixture(t), broken = signed(); broken.verdict.contracted = false; f.cache(broken);
  f.deps.fetch = async () => { f.calls++; return { ok: true, json: async () => signed() }; };
  assert.equal((await f.hook()).allow, true);
  assert.equal(f.calls, 1);
  for (const changes of [{ email: 'other@test' }, { pcId: 'other-PC' }]) {
    f.cache(signed(changes));
    f.deps.fetch = async () => { throw Error('offline'); };
    assert.equal((await f.hook()).allow, false);
  }
});
test('通信失敗: 7日以内のみ猶予、activeのみlocal-fallbackを記録', async t => {
  const f = fixture(t);
  f.cache(signed({ iat: seconds - 2 * 86400, exp: seconds - 86400 }));
  assert.equal((await f.hook()).allow, true);
  f.cache(signed({ iat: seconds - 8 * 86400, exp: seconds - 86400 }));
  assert.equal((await f.hook()).allow, false);
  f.write('claude-account-ledger.json', { version: 1, members: [{ email: 'user@example.test', status: 'active' }], contractedOrgUuids: [] });
  assert.equal((await f.hook()).allow, true);
  assert.match(f.log(), /local-fallback/);
  f.cache(signed({ contracted: false }));
  assert.equal((await f.hook()).allow, false, 'signed rejection overrides active ledger');
});
test('profile_unavailable は判定不能として以前の署名済み契約を利用', async t => {
  const f = fixture(t);
  f.cache(signed({ iat: seconds - 86400, exp: seconds - 1 }));
  f.deps.fetch = async () => ({ ok: true, json: async () => signed({ contracted: false, reason: 'profile_unavailable' }) });
  assert.equal((await f.hook()).allow, true);
  assert.equal((await f.hook()).allow, true, 'outage does not erase grace cache');
});
test('SessionStart 契約外通知は同日1回、翌日は再通知、stdout空', async t => {
  const f = fixture(t); f.cache(signed({ contracted: false, exp: seconds + 3 * 86400 }));
  await sessionStart(f.deps); await sessionStart(f.deps);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0][1][1], /契約外 Claude アカウントの起動を検知/);
  assert.equal(f.notifications[0][2].stdio, 'ignore');
  f.deps.now = () => now + 86400000;
  await sessionStart(f.deps);
  assert.equal(f.notifications.length, 2);
  assert.equal(f.output, '');
});
test('migrate plan/apply fetch往復、承認待ち・失敗、削除承認と編集後の保護', async t => {
  const f = fixture(t), root = path.join(f.home, 'downloads');
  f.write('.claude/next-session.md', 'secret 日本語');
  f.write('.claude/handoff-a/deep/a.md', 'handoff');
  f.write('downloads/repo/.git', 'gitdir: elsewhere');
  f.write('downloads/repo/HANDOVER.md', 'repo');
  f.write('downloads/not-repo/HANDOVER.md', 'exclude');
  f.write('downloads/repo/nested/HANDOVER.md', 'exclude');
  const run = args => main(['migrate', ...args], f.deps);
  assert.equal(await run(['--plan', '--root', root]), 0);
  assert.match(f.output, /path\tbytes\tsealedExists/);
  assert.ok(!f.output.includes('not-repo'));
  assert.ok(!f.output.includes('nested'));
  f.deps.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.action, 'unwrap');
    if (body.name === 'a.md') return { ok: true, json: async () => ({ status: 'approval_required' }) };
    const dataKey = crypto.privateDecrypt({ key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(body.wrappedKey, 'base64url')).toString('base64url');
    return { ok: true, json: async () => ({ status: 'ok', dataKey }) };
  };
  assert.equal(await run(['--apply', '--root', root]), 2);
  const records = JSON.parse(fs.readFileSync(path.join(f.home, '.claude/state/knowledge-migrate.json')));
  assert.equal(records.filter(r => r.roundTrip === 'ok').length, 2);
  assert.ok(records.every(r => fs.existsSync(r.path + '.lock') && fs.existsSync(r.path)));
  for (const args of [['--delete-plaintext'], ['--kim-approved'], ['--plan', '--apply']]) assert.equal(await run(args), 2);
  f.write('downloads/repo/HANDOVER.md', 'edited after verification');
  assert.equal(await run(['--delete-plaintext', '--kim-approved']), 0);
  assert.equal(fs.existsSync(path.join(f.home, '.claude/next-session.md')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.claude/handoff-a/deep/a.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'repo/HANDOVER.md')), true);
  f.deps.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok', dataKey: Buffer.alloc(32).toString('base64url') }) });
  assert.equal(await run(['--apply', '--root', root]), 2);
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.home, '.claude/state/knowledge-migrate.json'))).every(r => r.roundTrip === 'failed'));
});

test('migrate apply 完全成功と通信失敗時の平文保持', async t => {
  const f = fixture(t), root = path.join(f.home, 'empty');
  f.write('.claude/next-session.md', 'round-trip');
  f.deps.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const key = crypto.privateDecrypt({ key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(body.wrappedKey, 'base64url'));
    return { ok: true, json: async () => ({ status: 'ok', dataKey: key.toString('base64url') }) };
  };
  assert.equal(await main(['migrate', '--apply', '--root', root], f.deps), 0);
  assert.match(f.output, /"roundTrip":"ok"/);
  f.deps.fetch = async () => { throw Error('secret-oauth'); };
  assert.equal(await main(['migrate', '--apply', '--root', root], f.deps), 2);
  assert.equal(await main(['migrate', '--delete-plaintext', '--kim-approved'], f.deps), 0);
  assert.ok(fs.existsSync(path.join(f.home, '.claude/next-session.md')));
  assert.ok(!f.output.includes('secret-oauth'));
});

test('保護パスでフック例外ならdeny、非保護パスならアカウントI/O不要', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.home, 'knowledge-lock-pubkey.pem'));
  fs.mkdirSync(path.join(f.home, 'knowledge-lock-pubkey.pem'));
  assert.equal((await f.hook()).allow, false);
  assert.equal((await runHook({ tool_name: 'Bash', tool_input: { command: 'node --version' } }, f.deps)).allow, true);
});

test('verify-account の通信は4秒で中断し、安全側へ判定する', async t => {
  const f = fixture(t);
  f.deps.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => reject(Error('timeout was not enforced')), 5500);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
  });
  const start = Date.now();
  const result = await f.hook();
  assert.equal(result.allow, false);
  assert.ok(Date.now() - start < 5400);
});
