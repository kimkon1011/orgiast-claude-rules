import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test, { after } from 'node:test';
import { addCheck } from './auto-progress.mjs';
import { executeCheck, preflightCheck, hasBashEnvExpansion, hasCheckError, CHECK_ERROR_PATTERNS, resolveCheckShell, CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS, pendingAction } from './auto-progress-check.mjs';
import { readLedger, writeLedger, ledgerFile } from './auto-progress-ledger.mjs';
import { run as watch } from './auto-progress-watch.mjs';
import { run as digest } from './auto-progress-digest.mjs';
import { checkArrivals } from './checks/wechat-ingest-arrived.mjs';
import { addItem, listItems, markSeen } from './kim-inbox.mjs';
const homes = [];
const tmp = () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-check-')); homes.push(home); fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'seisaku-team@orgiast.jp' } })); return home; };
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
test('watch: before deadline stays open; overdue closes and retries final DM; a new revision can complete', async () => {
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
  assert.equal(readLedger(ledgerFile(home))[0].status, 'overdue_reported');
  code = 0;
  addCheck({ home, now: later + 1, session: 'session', check: 'node check.mjs', label: '着信再確認', deadline: '+24h' });
  await watch({ home, now: later, io }); await watch({ home, now: later, io });
  assert.equal(deliveries, 2);
  assert.equal(listItems(home).length, 1);
  const row = readLedger(ledgerFile(home)).at(-1);
  assert.equal(row.status, 'done'); assert.equal(row.checkText, '確認結果\n本文は捨てる');
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
  assert.match(messages[0], /未達: 着信確認\n達成 0件 \/ 未達 1件[\s\S]*Claude の次の手: 再試行する/);

  // 7時間後: 前回DMから1時間なので再送しない
  await watch({ home, now: now + 7 * 3600000, io });
  assert.equal(messages.length, 1);

  // 12時間後: 前回DMから6時間経過で2回目の定期DM
  await watch({ home, now: now + 12 * 3600000, io });
  assert.equal(messages.length, 2);

  // 24時間後（期限切れ）: overdue の未達（期限超過）通知
  await watch({ home, now: now + 24 * 3600000, io });
  assert.equal(messages.length, 3);
  assert.match(messages[2], /期限切れ（/);
  });
  test('watch: failed completion delivery retries without running check again; dry run has no side effects', async () => {
  const home = tmp(); register(home); let checks = 0, sends = 0;
  const io = { ...baseIo, executeCheck: () => { checks++; return { code: 0, text: '完了' }; },
    notifyOwner: () => assert.fail('completion must not use Discord'),
    addKimInboxItem: async (home, options) => { if (++sends === 1) throw new Error('disk full'); return addItem(home, options); } };
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
test('executeCheck honors exit contract, full output and bounded execution', () => {
  const command = `"${process.execPath}" -e "console.log('first');console.log('second');process.exit(1)"`;
  assert.deepEqual(executeCheck({ check: command }, { home: tmp() }), { code: 1, text: 'first\nsecond', stderr: '' });
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
test('executeCheck reports a timeout as the bound and how to extend it, not as a shell failure', () => {
  const error = Object.assign(new Error('spawnSync C:\Program Files\Git\bin\bash.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const result = executeCheck({ check: 'slow', checkTimeoutMs: 45000 }, { home: tmp(), shellPath: null, spawnImpl: () => ({ status: null, error, stdout: '' }) });
  assert.equal(result.code, null);
  assert.match(result.text, /45 秒の上限/); assert.match(result.text, /--timeout/); assert.doesNotMatch(result.text, /bash.exe/);
});
test('addCheck --timeout stores checkTimeoutMs, probes with it, and rejects out-of-range values', () => {
  const home = tmp(), probed = [];
  const row = addCheck({ home, now, session: 'slow-session', check: 'node slow.mjs', label: '遅い check', deadline: '+24h', timeout: '180',
    probe: r => { probed.push(r.checkTimeoutMs); return { code: 1, text: '未達' }; } });
  assert.equal(row.checkTimeoutMs, 180000); assert.deepEqual(probed, [180000]);
  assert.equal(readLedger(ledgerFile(home)).at(-1).checkTimeoutMs, 180000);
  assert.equal('checkTimeoutMs' in addCheck({ home, now, session: 'plain', check: 'x', label: 'x', deadline: '+24h' }), false);
  for (const timeout of ['0', '301', 'soon']) assert.throws(() => addCheck({ home, now, session: 'bad', check: 'x', label: 'x', deadline: '+24h', timeout }), /--timeout/);
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
test('digest: hundreds of rows across three categories are all delivered in 1800-char chunks', async () => {
  const home = tmp(), messages = [];
  const rows = Array.from({ length: 200 }, (_, i) => ({ sessionId: `s${i}`, promise: '長い約束'.repeat(100), status: i % 3 === 0 ? 'done' : i % 3 === 1 ? 'waiting_user' : 'open',
    ts: new Date(now - 1000).toISOString(), doneAt: new Date(now).toISOString(), nextKim: i % 3 === 1 ? '判断してください'.repeat(100) : 'なし' }));
  const io = { readLedger: () => rows, notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  // 2026-11-04 仕様変更: 全200件を数え、名前の羅列・分割をやめて1通に要約する。
  const result = await digest({ home, now, slot: '朝', io });
  assert.equal(result.count, 200);
  assert.equal(result.parts, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /完了 67件/);
  assert.match(messages[0], /あなたの返事待ち/);
  assert.ok(messages[0].split('\n').length <= 10);
  assert.ok(messages[0].length <= 1800);
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
  } }), { code: 1, text: '未達', stderr: '' });
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

test('check completion requires inbox read-back and does not retry after success', async () => {
 const home = tmp(); register(home);
 let calls = 0;
 const io = { ...baseIo, executeCheck: () => ({ code: 0, text: '完了' }),
   notifyOwner: () => assert.fail('must bypass owner DM policy'),
   addKimInboxItem: async (home, options) => { calls++; return addItem(home, options); } };
 await watch({ home, now, io });
 await watch({ home, now, io });
 assert.equal(calls, 1);
 assert.equal(readLedger(ledgerFile(home))[0].checkNotifiedResult, 'done');
});

test('missing Discord, quiet hours and daily DM quota do not suppress check completion or nextClaude', async () => {
  const home = tmp();
  addCheck({ home, now, session: 'quiet-check', check: 'x', label: '到着確認', deadline: '+24h', nextClaude: '添付を確認して承認用の本文を作る' });
  const later = Date.parse('2026-11-04T16:00:00Z'); // 01:00 JST
  const io = { ...baseIo, executeCheck: () => ({ code: 0, text: '到着済み' }), notifyOwner: () => assert.fail('no Discord') };
  const summary = await watch({ home, now: later, io });
  assert.deepEqual(summary.errors, []);
  const [item] = listItems(home), [row] = readLedger(ledgerFile(home));
  assert.equal(item.kind, 'info');
  assert.match(item.text, /check 達成: 到着確認/);
  assert.match(item.text, /作業全体の完了は未確認です。Claude の次の手（実行状況を確認して続行）: 添付を確認して承認用の本文を作る/);
  assert.equal(row.doneInboxId, item.id);
  assert.equal(row.doneNotifiedAt, new Date(later).toISOString());
});

test('missing or mismatched read-back leaves completion unnotified and retries without rerunning check', async () => {
  const home = tmp(); register(home); let checks = 0, readback = false;
  const io = { ...baseIo, executeCheck: () => { checks++; return { code: 0, text: '達成' }; },
    notifyOwner: () => assert.fail('no Discord'), listKimInboxItems: home => readback ? listItems(home) : [] };
  const first = await watch({ home, now, io });
  assert.match(first.errors.join(), /read-back failed/);
  const [failed] = readLedger(ledgerFile(home));
  assert.equal(failed.status, 'done'); assert.equal(failed.checkNotifiedResult, undefined); assert.equal(failed.doneNotifiedAt, undefined);
  readback = true; await watch({ home, now, io }); await watch({ home, now, io });
  assert.equal(checks, 1); assert.equal(listItems(home).length, 1);
  assert.equal(readLedger(ledgerFile(home))[0].checkNotifiedResult, 'done');
});

test('legacy false notification flags including doneNotifiedAt are recovered once with distinct receipts', async () => {
  const home = tmp();
  const base = { status: 'done', ts: '2026-10-29T00:00:00Z', doneAt: '2026-10-30T03:00:00Z', check: 'never execute', checkResult: 'done', checkNotifiedResult: 'done', doneNotifiedAt: '2026-11-04T05:00:00Z', checkText: '達成' };
  writeLedger(ledgerFile(home), ['job-1', 'job-2'].map(sessionId => ({ ...base, sessionId, label: '同じ見出し' })));
  const io = { ...baseIo, executeCheck: () => assert.fail('must not rerun completed checks'), notifyOwner: () => assert.fail('no Discord') };
  await watch({ home, now, io }); await watch({ home, now, io });
  const items = listItems(home); assert.equal(items.length, 2);
  const rows = readLedger(ledgerFile(home)); assert.notEqual(rows[0].doneInboxId, rows[1].doneInboxId);
  assert.ok(rows.every(row => row.checkNotifiedResult === 'done' && row.doneInboxVerifiedAt));
  markSeen(home, items[0].id);
  // Simulate a crash after inbox persistence but before the receipt reaches the ledger.
  writeLedger(ledgerFile(home), rows.map(({ doneInboxId, doneInboxVerifiedAt, ...row }) => row));
  await watch({ home, now, io });
  assert.equal(listItems(home).length, 2);
  assert.equal(listItems(home).find(item => item.id === items[0].id).status, 'seen');
});

test('ledger failure after delivery retains inbox and retries the receipt without duplicates', async () => {
  const home = tmp(); register(home); let writes = 0;
  const io = { ...baseIo, executeCheck: () => ({ code: 0, text: '達成' }), notifyOwner: () => assert.fail('no Discord'),
    writeLedger: (file, rows) => { if (++writes === 2) throw new Error('receipt write failed'); writeLedger(file, rows); } };
  assert.match((await watch({ home, now, io })).errors.join(), /receipt write failed/);
  assert.equal(readLedger(ledgerFile(home))[0].checkNotifiedResult, undefined);
  assert.equal(listItems(home).length, 1);
  await watch({ home, now, io: { ...io, writeLedger, executeCheck: () => assert.fail('already done') } });
  assert.equal(readLedger(ledgerFile(home))[0].checkNotifiedResult, 'done');
  assert.equal(listItems(home).length, 1);
});

test('ask file 全文を保存し、人待ちを通知して期限切れは最終報告1回で閉じる', async () => {
 const home = tmp();
 const askFile = path.join(home, 'ask.txt');
 const ask = 'Google アカウントで開いてください。\nスクリプト URL を貼ってください。';
 fs.writeFileSync(askFile, ask);
 const row = addCheck({ home, now, session: 'human', check: 'node check.mjs', label: '清掃報告GAS URL待ち', deadline: '+24h', askFile });
 assert.equal(readLedger(ledgerFile(home))[0].ask, ask);
 const messages = [];
 const io = { ...baseIo, executeCheck: () => ({ code: 1, text: '未達' }), notifyOwner: async (_, text) => { messages.push(text); return { delivered: 'inbox' }; } };
 await watch({ home, now: now + 6 * 3600000, io });
 assert.match(messages[0], /あなたの作業待ち: 清掃報告GAS URL待ち/);
 assert.ok(messages[0].includes(ask));
 assert.doesNotMatch(messages[0], /check の実行ログ/);
 await watch({ home, now: now + 24 * 3600000, io });
 assert.match(messages[1], /期限切れ（2026-10-24T00:00:00.000Z）/);
 await watch({ home, now: now + 47 * 3600000, io });
 assert.equal(messages.length, 2);
 await watch({ home, now: now + 48 * 3600000, io });
 assert.equal(messages.length, 2);
 assert.ok(messages[1].includes(ask));
 assert.equal(readLedger(ledgerFile(home))[0].status, 'overdue_reported');
 assert.ok(readLedger(ledgerFile(home))[0].overdueReportedAt);
 assert.doesNotMatch(fs.readFileSync(path.join(home, '.claude', 'next-session.md'), 'utf8'), /check の実行ログ/);
});

 test('人待ちで ask がなければ promise を全文表示する', () => {
   const promise = 'URL を受け取ったら修正します。\n対象の URL を貼ってください。';
   const text = pendingAction({ label: 'URL待ち', promise, nextKim: '返信' });
   assert.ok(text.includes(promise));
   assert.doesNotMatch(text, /check の実行ログ/);
   assert.ok(pendingAction({ label: '確認', nextClaude: '再試行', ask: '承認してください' }).includes('承認してください'));
 });

test('CLI --ask-file を ledger の ask に渡す（欠落ファイルでは登録しない）', () => {
 const home = tmp(), askFile = path.join(home, 'request.txt');
 fs.writeFileSync(askFile, '依頼全文\n二行目');
 const args = ['tools/auto-progress.mjs', '--add-check', '--session', 'cli', '--check', 'node -e "process.exit(1)"', '--deadline', '+7d', '--label', '承認待ち', '--ask-file', askFile];
 const env = { ...process.env, HOME: home, ORGIAST_HOME: home };
 const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
 assert.equal(result.status, 0, result.stderr);
 assert.equal(readLedger(ledgerFile(home))[0].ask, '依頼全文\n二行目');
 fs.unlinkSync(askFile);
 assert.equal(spawnSync(process.execPath, args, { env, encoding: 'utf8' }).status, 2);
 assert.equal(readLedger(ledgerFile(home)).length, 1);
});

test('preflightCheck: $env: を二重引用符で使う check は静的検査で拒否される', () => {
  const home = os.tmpdir();
  const badCheck = 'powershell -NoProfile -Command "if ((Get-Item $env:USERPROFILE\\.claude\\logs\\x.log -ErrorAction Stop).LastWriteTime -ge [datetime]\'2026-10-28 02:00\') { exit 0 } else { exit 1 }"';
  const pf = preflightCheck({ check: badCheck }, { home });
  assert.equal(pf.ok, false);
  assert.equal(pf.preflight, 'static_error');
  assert.match(pf.text, /\$env:/);
});

test('preflightCheck: --force-check で静的検査をスキップできる', () => {
  const home = os.tmpdir();
  const badCheck = 'powershell -NoProfile -Command "if ((Get-Item $env:USERPROFILE\\.claude\\logs\\x.log -ErrorAction Stop).LastWriteTime -ge [datetime]\'2026-10-28 02:00\') { exit 0 } else { exit 1 }"';
  const pf = preflightCheck({ check: badCheck }, { home, forceCheck: true });
  assert.notEqual(pf.preflight, 'static_error');
});

test('preflightCheck: 未達 check(exit 1・stderr無し)はそのまま通る', () => {
  const home = os.tmpdir();
  const pf = preflightCheck({ check: 'exit 1' }, { home });
  assert.equal(pf.ok, true);
  assert.equal(pf.preflight, 'unmet');
});

test('hasBashEnvExpansion / hasCheckError は期待どおり判定する', () => {
  assert.equal(hasBashEnvExpansion('powershell -Command "$env:USERPROFILE"'), true);
  assert.equal(hasBashEnvExpansion('printf hello'), false);
  assert.equal(hasBashEnvExpansion('echo \\$env:USERPROFILE'), false);
  assert.equal(hasCheckError('bash: command not found: foo'), true);
  assert.equal(hasCheckError('ok'), false);
  assert.equal(CHECK_ERROR_PATTERNS.length >= 5, true);
});
