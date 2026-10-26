import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { addCheck } from './auto-progress.mjs';
import { executeCheck, resolveCheckShell, CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS } from './auto-progress-check.mjs';
import { readLedger, writeLedger, ledgerFile } from './auto-progress-ledger.mjs';
import { run as watch } from './auto-progress-watch.mjs';
import { run as digest } from './auto-progress-digest.mjs';
import { checkArrivals } from './checks/wechat-ingest-arrived.mjs';
const homes = [];
const tmp = () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-check-')); homes.push(home); return home; };
after(() => homes.forEach(home => fs.rmSync(home, { recursive: true, force: true })));
const now = Date.parse('2026-10-23T00:00:00Z');
const register = home => addCheck({ home, now, session: 'session', check: 'node check.mjs', label: '着信確認', deadline: '+24h' });
const baseIo = { sheetConfig: () => null, digest: async () => ({}), resume: () => assert.fail('check must not resume'), askLlm: () => assert.fail('check must not infer') };
test('CLI validates deadline, preserves promise and registers a new revision', () => {
  const home = tmp();
  writeLedger(ledgerFile(home), [{ ts: new Date(now - 1).toISOString(), sessionId: 'session', status: 'open', promise: '元の約束', owner: 'owner' }]);
  const row = register(home);
  assert.equal(row.promise, '元の約束'); assert.equal(row.owner, 'owner');
  assert.equal(row.deadlineAt, '2026-10-24T00:00:00.000Z');
  assert.equal(readLedger(ledgerFile(home))[0].status, 'superseded');
  assert.throws(() => addCheck({ home, session: 's', check: 'x', label: 'x', deadline: 'bad' }), /deadline/);
  assert.equal(readLedger(ledgerFile(home)).length, 2);
});
test('watch: before deadline stays open; overdue queues once and retries DM; recovery sends completion once', async () => {
  const home = tmp(); register(home); let code = 1, deliveries = 0, fail = true;
  const io = { ...baseIo, executeCheck: () => ({ code, text: '確認結果\n本文は捨てる' }), notifyOwner: async () => { deliveries++; return { delivered: fail ? 'none' : 'dm' }; } };
  await watch({ home, now, io }); assert.equal(deliveries, 0);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'next-session.md')), false);
  const later = now + 86400000;
  assert.equal((await watch({ home, now: later, io })).errors.length, 1);
  fail = false;
  await watch({ home, now: later, io }); await watch({ home, now: later, io });
  assert.equal(deliveries, 2);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'next-session.md'), 'utf8').match(/- \[ \]/g).length, 1);
  code = 0;
  await watch({ home, now: later, io }); await watch({ home, now: later, io });
  assert.equal(deliveries, 3);
  const row = readLedger(ledgerFile(home))[0];
  assert.equal(readLedger(ledgerFile(home))[0].status, 'done'); assert.equal(row.checkText, '確認結果');
  assert.equal((await digest({ home, now: later, io: { notify: () => assert.fail('duplicate digest') } })).sent, false);
  });
  test('watch: 未達（code=1）でも6時間ごとに owner へ定期的に状況を DM する', async () => {
  const home = tmp();
  addCheck({ home, now, session: 'unmet-session', check: 'node check.mjs', label: '着信確認', deadline: '+24h', nextClaude: '再試行する' });
  const messages = [];
  const io = {
    ...baseIo,
    executeCheck: () => ({ code: 1, text: '未達: まだ届いていません' }),
    notifyOwner: async (_, text) => {
      messages.push(text);
      return { delivered: 'dm' };
    },
  };
  // 登録直後（0h）: 6時間未満なのでDMしない
  await watch({ home, now, io });
  assert.equal(messages.length, 0);

  // 1時間後: 6時間未満なのでDMしない
  await watch({ home, now: now + 3600000, io });
  assert.equal(messages.length, 0);

  // 6時間後: 1回目の定期DMが送信される
  await watch({ home, now: now + 6 * 3600000, io });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /未達: 未達: まだ届いていません \/ 次の手: 再試行する/);

  // 7時間後: 前回DMから1時間なので再送しない
  await watch({ home, now: now + 7 * 3600000, io });
  assert.equal(messages.length, 1);

  // 12時間後: 前回DMから6時間経過で2回目の定期DM
  await watch({ home, now: now + 12 * 3600000, io });
  assert.equal(messages.length, 2);

  // 24時間後（期限切れ）: overdue の未達（期限超過）通知
  await watch({ home, now: now + 24 * 3600000, io });
  assert.equal(messages.length, 3);
  assert.match(messages[2], /未達（期限超過）/);
  });
  test('watch: failed completion delivery retries without running check again; dry run has no side effects', async () => {
  const home = tmp(); register(home); let checks = 0, sends = 0;
  const io = { ...baseIo, executeCheck: () => { checks++; return { code: 0, text: '完了' }; }, notifyOwner: async () => ({ delivered: ++sends === 1 ? 'none' : 'dm' }) };
  const before = fs.readFileSync(ledgerFile(home), 'utf8');
  await watch({ home, now, dryRun: true, io });
  assert.equal(checks, 0); assert.equal(fs.readFileSync(ledgerFile(home), 'utf8'), before);
  await watch({ home, now, io }); await watch({ home, now, io }); await watch({ home, now, io });
  assert.equal(checks, 1); assert.equal(sends, 2);
});
test('check errors do not mark done; repeated errors notify once', async () => {
  const home = tmp(); register(home); const messages = [];
  const io = { ...baseIo, executeCheck: () => ({ code: 2, text: '実行エラー' }), notifyOwner: async (_, text) => { messages.push(text); return { delivered: 'dm' }; } };
  await watch({ home, now, io }); await watch({ home, now, io });
  assert.equal(messages.length, 1); assert.match(messages[0], /確認エラー/);
  assert.equal(readLedger(ledgerFile(home))[0].status, 'open');
});
test('executeCheck honors exit contract, first line and bounded execution', () => {
  const command = `"${process.execPath}" -e "console.log('first');console.log('second');process.exit(1)"`;
  assert.deepEqual(executeCheck({ check: command }, { home: tmp() }), { code: 1, text: 'first' });
  const result = executeCheck({ check: 'anything' }, { home: tmp(), shellPath: null, spawnImpl: (_, options) => {
    assert.equal(options.timeout, CHECK_TIMEOUT_MS); assert.equal(options.windowsHide, true);
    return { status: null, error: new Error('timeout'), stdout: '' };
  } });
  assert.equal(result.code, null); assert.match(result.text, /timeout/);
});
test('executeCheck lets a row extend its timeout for network-bound checks, bounded and validated', () => {
  const seen = [];
  const spawnImpl = (_, options) => { seen.push(options.timeout); assert.equal(options.env.ORGIAST_CHECK_TIMEOUT_MS, String(options.timeout)); return { status: 0, stdout: 'ok' }; };
  executeCheck({ check: 'gh run view', checkTimeoutMs: 180000 }, { home: tmp(), shellPath: null, spawnImpl });
  executeCheck({ check: 'gh run view', checkTimeoutMs: 999999 }, { home: tmp(), shellPath: null, spawnImpl });
  executeCheck({ check: 'gh run view', checkTimeoutMs: 0 }, { home: tmp(), shellPath: null, spawnImpl });
  executeCheck({ check: 'gh run view', checkTimeoutMs: 'soon' }, { home: tmp(), shellPath: null, spawnImpl });
  assert.deepEqual(seen, [180000, MAX_CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS]);
});
test('WeChat counts current/previous month only, inclusive since, ignores empty/invalid/unrelated data without exposing text', () => {
  const home = tmp(), dir = path.join(home, '.claude', 'line-openchat'); fs.mkdirSync(dir, { recursive: true });
  const since = '2026-09-30T12:30:00Z';
  const valid = { chat: 'WeChat group', receivedAt: since, text: 'PRIVATE BODY' };
  fs.writeFileSync(path.join(dir, '2026-09.jsonl'), JSON.stringify(valid));
  fs.writeFileSync(path.join(dir, '2026-10.jsonl'), ['broken', 'null', JSON.stringify({ ...valid, receivedAt: '2026-10-22T00:00:00Z' }), ...[
    { chat: 'Other' }, { text: ' ' }, { receivedAt: 'bad' }, { receivedAt: '2026-09-29T00:00:00Z' }
  ].map(patch => JSON.stringify({ ...valid, ...patch }))].join('\n'));
  const result = checkArrivals({ home, since, now: new Date(now) });
  assert.deepEqual(result, { code: 0, text: 'WeChat 着信 2件・最終 2026-10-22T00:00:00.000Z' });
  assert.equal(checkArrivals({ home, since: '2026-10-23', now: new Date(now) }).code, 1);
  assert.throws(() => checkArrivals({ home, since: 'bad' }));
});
test('WeChat handles January rollover and filesystem errors distinctly', () => {
  const home = tmp(), dir = path.join(home, '.claude', 'line-openchat'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-12.jsonl'), JSON.stringify({ chat: 'WeChat', receivedAt: '2026-12-31T12:00:00Z', text: 'private' }));
  assert.equal(checkArrivals({ home, now: new Date(2027, 0, 2) }).code, 0);
  fs.mkdirSync(path.join(dir, '2027-01.jsonl'));
  assert.throws(() => checkArrivals({ home, now: new Date(2027, 0, 2) }));
});
test('watch budget prioritizes checks and leaves room before hourly trigger', async () => {
  const home = tmp(); register(home);
  writeLedger(ledgerFile(home), [...readLedger(ledgerFile(home)), { sessionId: 'legacy', status: 'open', promise: 'old', ts: new Date(now - 86400000).toISOString() }]);
  let elapsed = 0, checks = 0;
  await watch({ home, now, io: { ...baseIo, clock: () => now + elapsed,
    executeCheck: () => { checks++; elapsed = 24 * 60000; return { code: 1, text: '未達' }; },
    transcriptEvidence: () => assert.fail('legacy must stop with insufficient time') } });
  assert.equal(checks, 1);
});
test('digest: hundreds of rows across three categories stay within one DM and 1800 chars', async () => {
  const home = tmp(), messages = [];
  const rows = Array.from({ length: 200 }, (_, i) => ({ sessionId: `s${i}`, promise: '長い約束'.repeat(100), status: i % 3 === 0 ? 'done' : i % 3 === 1 ? 'waiting_user' : 'open',
    ts: new Date(now - 1000).toISOString(), doneAt: new Date(now).toISOString(), nextKim: i % 3 === 1 ? '判断してください'.repeat(100) : 'なし' }));
  const io = { readLedger: () => rows, notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  // 変化分（完了67件・判断待ち67件）だけを数え、枠は1通まで。
  const result = await digest({ home, now, slot: '朝', io });
  assert.equal(result.parts, 1); assert.equal(result.count, 134);
  assert.ok(messages[0].length < 1800);
  assert.equal((await digest({ home, now: now + 3600000, slot: '朝', io })).sent, false);
});

test('resolveCheckShell selects Git Bash in candidate order and honors override', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' };
  const candidates = [path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')];
  candidates.forEach((expected, index) => {
    assert.equal(resolveCheckShell({ platform: 'win32', env, exists: candidate => candidates.slice(index).includes(candidate) }), expected);
  });
  assert.equal(resolveCheckShell({ platform: 'win32', env: { ...env, ORGIAST_CHECK_SHELL: 'custom-bash' }, exists: () => assert.fail('override must win') }), 'custom-bash');
  assert.equal(resolveCheckShell({ platform: 'win32', env, exists: () => false }), null);
  assert.equal(resolveCheckShell({ platform: 'win32', env: {}, exists: () => assert.fail('no candidate') }), null);
  assert.equal(resolveCheckShell({ platform: 'linux', env: { ORGIAST_CHECK_SHELL: 'custom-bash' }, exists: () => assert.fail('non-Windows') }), null);
});
test('executeCheck invokes explicit Bash without shell and preserves execution options', () => {
  const home = tmp(), check = 'gh pr view 1145 --jq .state | grep -q MERGED';
  assert.deepEqual(executeCheck({ check, checkCwd: home }, { home, shellPath: 'git-bash', spawnImpl: (shell, args, opts) => {
    assert.equal(shell, 'git-bash'); assert.deepEqual(args, ['-c', check]);
    assert.equal(Object.hasOwn(opts, 'shell'), false); assert.equal(opts.cwd, home);
    assert.equal(opts.timeout, CHECK_TIMEOUT_MS); assert.equal(opts.maxBuffer, 64 * 1024);
    assert.equal(opts.windowsHide, true); assert.equal(opts.encoding, 'utf8'); assert.equal(opts.env.ORGIAST_HOME, home);
    return { status: 1, stdout: '' };
  } }), { code: 1, text: '未達' });
});
test('executeCheck with null shell retains the shell:true invocation', () => {
  executeCheck({ check: 'check command' }, { shellPath: null, spawnImpl: (...args) => {
    assert.equal(args.length, 2); assert.equal(args[0], 'check command'); assert.equal(args[1].shell, true);
    return { status: 0, stdout: 'ok' };
  } });
});
for (const { code, allowMet, accepted } of [
  { code: 1, accepted: true }, { code: 0, accepted: false },
  { code: 0, allowMet: true, accepted: true }, { code: null, accepted: false }, { code: 2, accepted: false },
]) {
  test(`addCheck probe code=${code} allowMet=${!!allowMet}`, () => {
    const home = tmp(); register(home);
    const file = ledgerFile(home), before = fs.readFileSync(file, 'utf8');
    const cwd = home;
    const add = () => addCheck({ home, now: now + 1, session: 'session', check: 'check command', label: 'test', deadline: '+24h', cwd, allowMet,
      probe: row => { assert.deepEqual(row, { check: 'check command', checkCwd: cwd, cwd }); return { code, text: 'probe result' }; } });
    if (accepted) { add(); assert.equal(readLedger(file).length, 2); }
    else {
      assert.throws(add, code === 0 ? /既に達成.*probe result/ : /この PC で実行できません.*probe result/);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
  });
}
