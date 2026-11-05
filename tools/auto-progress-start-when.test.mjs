import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addCheck, isTimeOnlyCheck, main } from './auto-progress.mjs';
import { run, resumeSession, MAX_RESUMES_PER_RUN } from './auto-progress-watch.mjs';
import { ledgerFile, readLedger, writeLedger, applyPromise } from './auto-progress-ledger.mjs';
import { formatDigest, run as digest } from './auto-progress-digest.mjs';
import { listItems } from './kim-inbox.mjs';
const now = Date.parse('2026-11-02T03:00:00Z');
function setup(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-start-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = { home, now, cwd: home, session: 'scheduled', label: '予約作業', deadline: '+24h', startWhen: 'exit 0', nextClaude: '成果物を作って検証する', ...extra };
  return { home, options };
}
const ioBase = { clock: () => now, sheetConfig: () => null, transcriptFiles: [], digest: async () => ({}),
  askLlm: () => assert.fail('予約中は停滞判定しない') };
test('時計だけの判定は拒否し、成果物の判定は許可する', t => {
  const { options } = setup(t);
  for (const check of [
    `node -e "process.exit(Date.now()>=Date.parse('2026-11-03T23:00:00+09:00')?0:1)"`,
    `node -e "process.exit(new Date().getTime()>123?0:1)"`,
    `powershell -Command "if ((Get-Date) -ge [datetime]'2026-11-03') { exit 0 } else { exit 1 }"`,
    `[ $(date +%s) -ge 123456 ]`,
  ]) {
    assert.equal(isTimeOnlyCheck(check), true, check);
    assert.throws(() => addCheck({ ...options, startWhen: undefined, check }), /時刻だけの check/);
  }
  for (const check of ['git ls-remote origin main', `node -e "process.exit(require('fs').existsSync('x')?0:1)"`, 'gh pr view 1 | grep -q MERGED',
    `node -e "process.exit(Date.now()>123 && require('fs').existsSync('x')?0:1)"`,
    `node -e "process.exit(Date.now()>Number(process.argv[1])?0:1)"`]) {
    assert.equal(isTimeOnlyCheck(check), false, check);
    assert.equal(addCheck({ ...options, startWhen: undefined, check, probe: () => ({ code: 1 }) }).status, 'open');
  }
});
test('予約登録とprobe、必須引数、Stop更新で予約を保持する', t => {
  const { options, home } = setup(t);
  assert.throws(() => addCheck({ ...options, nextClaude: '' }), /next-claude/);
  assert.throws(() => addCheck({ ...options, probe: () => ({ code: 2 }) }), /実行できません/);
  for (const code of [0, 1]) {
    const row = addCheck({ ...options, probe: r => { assert.equal(r.check, options.startWhen); return { code }; } });
    assert.equal(row.status, 'scheduled');
    assert.equal(row.nextClaude, options.nextClaude);
    const rows = applyPromise([row], { sessionId: row.sessionId, ts: new Date(now + 1).toISOString(), status: 'open', promise: '続きを実行' });
    assert.equal(rows[1].status, 'scheduled');
    assert.equal(rows[1].startWhen, row.startWhen);
  }
  const previous = process.env.ORGIAST_HOME;
  try {
    process.env.ORGIAST_HOME = home;
    assert.equal(main(['--start-when', 'exit 0', '--session', 'cli', '--label', 'CLI予約', '--deadline', '+24h', '--next-claude', '作業する']).status, 'scheduled');
  } finally { if (previous === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = previous; }
});
test('開始条件未達はlastCheckedAtだけ更新し、条件達成だけでは完了しない', async t => {
  for (const code of [1, 0]) {
    const { options, home } = setup(t); const original = addCheck(options); let resumes = 0;
    await run({ home, now, io: { ...ioBase, executeCheck: () => ({ code }),
      resume: async (row, opts) => { resumes++; assert.equal(opts.reason, 'scheduled-start'); assert.equal(row.nextClaude, options.nextClaude);
        assert.equal(readLedger(ledgerFile(home))[0].status, 'starting'); assert.ok(readLedger(ledgerFile(home))[0].startedAt);
        return { outcome: 'progressed', reason: '着手した' }; },
      notifyOwner: () => assert.fail('条件達成だけでは通知しない') } });
    const row = readLedger(ledgerFile(home))[0];
    assert.equal(resumes, code === 0 ? 1 : 0);
    assert.equal(row.status, code === 0 ? 'open' : 'scheduled');
    if (code === 1) assert.deepEqual(row, { ...original, lastCheckedAt: new Date(now).toISOString() });
  }
});
test('deferredは回数を消費せず次回再試行、doneで完了通知は一度だけ', async t => {
  const { options, home } = setup(t); addCheck(options);
  let outcome = 'deferred', calls = 0, notices = 0;
  const io = { ...ioBase, executeCheck: () => ({ code: 0 }), resume: async () => { calls++; return { outcome, reason: outcome }; },
    notifyOwner: async () => { notices++; return { delivered: 'dm' }; } };
  await run({ home, now, io });
  let row = readLedger(ledgerFile(home))[0];
  assert.equal(row.status, 'scheduled'); assert.equal(row.resumeCount, 0); assert.ok(row.resumeDeferredAt); assert.equal(notices, 0);
  outcome = 'done'; await run({ home, now, io }); await run({ home, now, io });
  row = readLedger(ledgerFile(home))[0];
  assert.equal(row.status, 'done'); assert.equal(calls, 2); assert.equal(notices, 1);
});
test('完了check併用は成果確認がexit 0のときだけdone', async t => {
  for (const code of [0, 1, 2]) {
    const { options, home } = setup(t, { check: 'artifact-check' }); addCheck(options); const notices = [];
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
    await run({ home, now, io: { ...ioBase, executeCheck: row => ({ code: row.check === 'exit 0' ? 0 : code, text: '成果確認' }),
      resume: async () => ({ outcome: 'done', reason: '作成済み' }), notifyOwner: async (_, text) => { notices.push(text); return { delivered: 'dm' }; } } });
    assert.equal(readLedger(ledgerFile(home))[0].status, code === 0 ? 'done' : 'open');
    assert.equal(notices.filter(text => /完了/.test(text)).length, 0);
    assert.equal(listItems(home).filter(item => /check 達成/.test(item.text)).length, code === 0 ? 1 : 0);
    if (code === 0) assert.ok(readLedger(ledgerFile(home))[0].doneInboxVerifiedAt);
  }
});
test('needs_user / blocked / error と起動例外を記録する', async t => {
  for (const state of ['needs_user', 'blocked', 'error', 'throw']) {
    const { options, home } = setup(t); addCheck(options);
    await run({ home, now, io: { ...ioBase, executeCheck: () => ({ code: 0 }), resume: async () => {
      if (state === 'throw') throw Error('起動失敗'); return { outcome: state, nextKim: 'なし' };
    } } });
    const row = readLedger(ledgerFile(home))[0];
    assert.equal(row.status, state === 'needs_user' ? 'waiting_user' : 'open'); assert.ok(row.startedAt);
  }
});
test('dry-run・無人処理・時間予算では開始条件を実行しない', async t => {
  for (const mode of ['dry', 'unattended', 'budget']) {
    const { options, home } = setup(t); const row = addCheck(options);
    if (mode === 'unattended') writeLedger(ledgerFile(home), [{ ...row, cwd: path.join(home, '.claude', 'auto-session') }]);
    let clocks = 0;
    await run({ home, now, dryRun: mode === 'dry',
      io: { ...ioBase, clock: () => mode === 'budget' && clocks++ ? now + 24 * 60000 : now,
        executeCheck: () => assert.fail(mode), resume: () => assert.fail(mode) } });
    assert.equal(readLedger(ledgerFile(home))[0].status, 'scheduled');
  }
});
test('静穏時間（JST 01:00）でも開始条件を確かめ、満たせば着手する（夜間着手が主用途）', async t => {
  const { options, home } = setup(t); addCheck(options);
  const night = Date.parse('2026-11-02T16:00:00Z');
  let started = 0;
  await run({ home, now: night, io: { ...ioBase, clock: () => night,
    executeCheck: () => ({ code: 0, text: 'ok' }),
    resume: async () => { started++; return { outcome: 'progressed', state: 'progressed', reason: '着手' }; } } });
  assert.equal(started, 1);
  assert.equal(readLedger(ledgerFile(home)).at(-1).status, 'open');
});
test('期限超過は開始せず起票・通知し、再巡回で重複通知しない', async t => {
  const { options, home } = setup(t); addCheck(options); let notices = 0;
  const io = { ...ioBase, executeCheck: () => assert.fail('期限超過'), resume: () => assert.fail('期限超過'),
    notifyOwner: async () => { notices++; return { delivered: 'dm' }; } };
  for (let i = 0; i < 2; i++) await run({ home, now: now + 10 * 86400000, io });
  assert.equal(readLedger(ledgerFile(home))[0].status, 'start_overdue'); assert.equal(notices, 1);
  assert.match(fs.readFileSync(path.join(home, '.claude', 'next-session.md'), 'utf8'), /成果物を作って検証する/);
});
test('巡回あたりの起動上限を予約にも適用する', async t => {
  const { options, home } = setup(t);
  for (let i = 0; i < MAX_RESUMES_PER_RUN + 1; i++) addCheck({ ...options, session: `s${i}` });
  let calls = 0;
  await run({ home, now, io: { ...ioBase, executeCheck: () => ({ code: 0 }), resume: async () => { calls++; return { outcome: 'progressed' }; } } });
  assert.equal(calls, MAX_RESUMES_PER_RUN);
});
test('resumeSessionは予約冒頭とnextClaudeを実際のプロンプトに渡す', async t => {
  const { options, home } = setup(t); const row = addCheck(options);
  await resumeSession(row, { home, reason: 'scheduled-start', io: { executable: 'mock', runChild: async (_, prompt) => {
    assert.match(prompt, /^予約していた作業の開始条件を満たしました。予約: 「予約作業」。/);
    assert.ok(prompt.includes(`やること: ${options.nextClaude}`)); return { status: 'failure', deferred: true };
  } } });
});
test('定期digestに開始予約と期限超過が出る', async t => {
  const { options, home } = setup(t); const row = addCheck(options);
  // 開始予約は「変化」ではないので、毎朝の定時報告（朝枠）に載ることを確かめる。日付を変えて同枠の重複抑止を避ける。
  for (const [i, status] of ['scheduled', 'start_overdue'].entries()) {
    writeLedger(ledgerFile(home), [{ ...row, status }]);
    assert.match(formatDigest([{ ...row, status }]), /開始予約.*予約作業.*開始条件の最終確認/);
    const messages = [];
    await digest({ home, now: now + i * 86400000, slot: '朝', io: { localOwner: 'owner', notifyOwner: async (_, message) => { messages.push(message); return { delivered: 'dm' }; } } });
    // 2026-11-04 仕様変更: 予約も依頼された進行中の作業として朝夕1通に集約する。
    assert.ok(messages.some(message => /進行中 1件.*予約作業/.test(message)));
    assert.equal(messages.length, 1);
  }
});
