import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatDoneLine, formatDoneMessage, formatDoneBacklogMessages, gatherEvidence, deterministicVerdict, judge, evidenceSummary, logDoneDm, run } from './auto-progress-watch.mjs';
import { cleanupOldLedgerTemps, ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';

test('共有ファイルが新しくてもセッションの会話・実行が25時間前ならstalled', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  const old = now - 25 * 3600000;
  const row = { promise: '次のメッセージで仕上げる', ts: new Date(old - 3600000).toISOString() };
  const evidence = gatherEvidence(row, '/unused', {
    transcriptEvidence: () => ({ count: 1, lastAt: old, snippets: [] }),
    recentFiles: () => ({ lastAt: now, names: ['shared.md'] }),
    autoSessionRuns: () => ({ lastAt: old, names: ['session.json'] }),
  });
  assert.equal(evidence.lastEvidenceAt, old);
  assert.equal(deterministicVerdict(evidence, now).verdict, 'stalled');
  assert.equal(deterministicVerdict({ ...evidence, lastEvidenceAt: now }, now).verdict, 'stalled');
  assert.equal(judge(row, evidence, now, { askLlm: () => null }).verdict, 'stalled');
  assert.match(evidenceSummary(row, evidence, now), /shared\.md/);
  for (const source of ['transcript', 'runs']) {
    assert.equal(deterministicVerdict({ ...evidence, [source]: { ...evidence[source], lastAt: now } }, now).verdict, 'in_progress');
  }
});

test('完了通知はresumeの結果を使い、予告文を出さない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-notice-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'auto-progress-inbox');
  fs.mkdirSync(dir, { recursive: true });
  const row = { sessionId: 'd14902f9-example', cwd: 'C:\\projects\\event-shop', doneAt: '2026-10-25T16:30:00Z',
    promise: 'Claude が DB 列の確認、ビルドとコミット、本番デプロイを行います。https://event-shop.jp' };
  const resume = path.join(home, '.claude', 'auto-progress-resume-d14902f9.json');
  fs.writeFileSync(resume, JSON.stringify({ state: 'done', evidence: 'DB列確認・ビルド・本番デプロイ完了。', artifact: 'https://event-shop.jp' }));
  const expected = '✅ 完了: event-shop — DB列確認・ビルド・本番デプロイ完了。（成果物: https://event-shop.jp）（2026/10/26 JST）';
  assert.equal(formatDoneLine(row, { home }), expected);
  for (const message of [formatDoneMessage(row, { home }), formatDoneBacklogMessages([row], { home })[0].text]) {
    assert.ok(message.includes(expected));
    assert.doesNotMatch(message, /行います|宣言文/);
  }
  fs.writeFileSync(resume, '{broken');
  fs.writeFileSync(path.join(dir, `${row.sessionId}.jsonl`), [
    '{broken', JSON.stringify({ state: 'done', evidence: '旧結果' }),
    JSON.stringify({ state: 'done', evidence: '検証済み' + 'あ'.repeat(150), artifact: 'out/report' }),
    JSON.stringify({ state: 'blocked', evidence: '承認待ち' }),
  ].join('\n'));
  const inbox = formatDoneLine(row, { home });
  assert.ok(inbox.includes('検証済み' + 'あ'.repeat(116) + '（成果物: out/report）'));
  assert.doesNotMatch(inbox, /旧結果|承認待ち|行います/);
  fs.rmSync(path.join(dir, `${row.sessionId}.jsonl`));
  assert.ok(formatDoneLine(row, { home }).includes('（結果記録なし・宣言文）' + row.promise));
});

test('台帳 rename が2回失敗しても再試行で保存できる', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-retry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = ledgerFile(home);
  let attempts = 0;
  writeLedger(file, [{ sessionId: 'retry-ok', status: 'open' }], {
    renameSync(from, to) {
      attempts += 1;
      if (attempts <= 2) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      fs.renameSync(from, to);
    },
    sleepSync() {},
  });
  assert.equal(attempts, 3);
  assert.equal(readLedger(file)[0].sessionId, 'retry-ok');
});

test('台帳 rename が10回失敗しても巡回は落ちず、エラーを記録して通知を止める', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-failure-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-11-01T03:00:00Z');
  writeLedger(ledgerFile(home), [{
    ts: new Date(now - 2 * 3600000).toISOString(), pc: 'test-pc', user: 'test', owner: 'owner',
    sessionId: 'rename-failure', cwd: home, promise: 'checkを完了する', status: 'open',
    check: 'exit 0', deadlineAt: new Date(now + 3600000).toISOString(),
  }]);
  let attempts = 0;
  let notifications = 0;
  const summary = await run({ home, now, io: {
    clock: () => now,
    sheetConfig: () => null,
    transcriptFiles: [],
    executeCheck: () => ({ code: 0, text: '達成' }),
    notifyOwner: async () => { notifications += 1; return { delivered: 'dm' }; },
    digest: async () => ({}),
    ledgerIo: {
      renameSync() { attempts += 1; throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
      sleepSync() {},
    },
  } });
  assert.equal(attempts, 10);
  assert.equal(notifications, 0);
  assert.ok(summary.errors.some(error => error.includes('ledger-write-failed')));
  assert.match(fs.readFileSync(path.join(home, '.claude', 'logs', 'auto-progress-watch.log'), 'utf8'), /ledger-write-failed.*EPERM/);
  assert.equal(fs.existsSync(`${ledgerFile(home)}.${process.pid}.tmp`), false);
});

test('1時間より古い台帳 tmp だけを掃除する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cleanup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = ledgerFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const oldTemp = `${file}.old.tmp`;
  const freshTemp = `${file}.fresh.tmp`;
  fs.writeFileSync(oldTemp, 'old');
  fs.writeFileSync(freshTemp, 'fresh');
  const now = Date.parse('2026-11-01T03:00:00Z');
  fs.utimesSync(oldTemp, new Date(now - 3600001), new Date(now - 3600001));
  fs.utimesSync(freshTemp, new Date(now - 3599999), new Date(now - 3599999));
  assert.equal(cleanupOldLedgerTemps(file, { now }), 1);
  assert.equal(fs.existsSync(oldTemp), false);
  assert.equal(fs.existsSync(freshTemp), true);
});

test('done-dmログは本文を8000字まで保存する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-dm-log-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const message = '完了内容'.repeat(900);
  logDoneDm(home, { sessionId: 'done-full-text' }, { delivered: 'dm', channel: 'discord' }, message, Date.parse('2026-11-01T03:00:00Z'));
  const row = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'logs', 'auto-progress-done-dm.sent.jsonl'), 'utf8'));
  assert.equal(row.text, message);
  assert.equal(row.channel, 'discord');
});

test('再開上限の失敗は最近の活動やAI判定に優先してstalledになる', async () => {
  const { MAX_RESUMES } = await import('./auto-progress-watch.mjs');
  const now = Date.now();
  const evidence = { any: true, transcript: { count: 1, lastAt: now, snippets: ['done'] }, files: { names: [] }, runs: { names: [] } };
  for (const resumeOutcome of ['error: timeout (claude exit null):', 'timeout: expired', 'blocked: 成果記録なし']) {
    const result = judge({ resumeCount: MAX_RESUMES, resumeOutcome }, evidence, now, { askLlm() { assert.fail('上限到達時はAIを呼ばない'); } });
    assert.equal(result.verdict, 'stalled');
    assert.match(result.reason, new RegExp(`自動再開が${MAX_RESUMES}回失敗`));
    assert.equal(judge({ resumeCount: MAX_RESUMES - 1, resumeOutcome }, evidence, now, { askLlm: () => null }).verdict, 'in_progress');
  }
  for (const resumeOutcome of ['progressed: 検証中', 'done: 完了', 'deferred: 実行者なし', 'attempting']) {
    assert.equal(judge({ resumeCount: MAX_RESUMES, resumeOutcome }, evidence, now, { askLlm: () => null }).verdict, 'in_progress');
  }
});

test('timeoutを繰り返した実例は2回でSheetとDMまとめへ一度報告される', async t => {
  const { MAX_RESUMES } = await import('./auto-progress-watch.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-exhausted-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-11-02T00:00:00Z');
  writeLedger(ledgerFile(home), [{
    sessionId: '28c97712-092f-42d5-8f40-3efeb5ed3ef3', ts: new Date(now - 4 * 3600000).toISOString(),
    pc: 'test-pc', user: 'test', owner: 'kim', cwd: home, promise: 'Xの投稿を読み調査結果をまとめます',
    status: 'resumed', verdict: 'in_progress', reason: '判定AIが使えず様子見', nextKim: 'なし',
    resumeCount: 2, resumedAt: new Date(now - 60000).toISOString(), lastCheckedAt: new Date(now).toISOString(),
    resumeOutcome: 'error: timeout (claude exit null):', reportedKey: `stalled:true:${MAX_RESUMES}`,
  }]);
  const sheets = [], messages = [];
  const io = {
    clock: () => now, transcriptFiles: [], sheetConfig: () => ({}),
    transcriptEvidence: () => ({ count: 3, lastAt: now, snippets: ['自動再開の動作'] }),
    recentFiles: () => ({ names: [], lastAt: 0 }), autoSessionRuns: () => ({ names: [], lastAt: 0 }),
    askLlm: () => 'in_progress | 動作あり', resume: () => assert.fail('再開上限を超えてはいけない'),
    postSheet: async (_config, _tab, payload) => sheets.push(payload.row),
    digestIo: { label: 'test-pc', notify: async text => { messages.push(text); return { delivered: 'dm' }; } },
  };
  const summary = await run({ home, now, io });
  assert.equal(summary.stalled, 1);
  assert.equal(summary.resumed, 0);
  assert.equal(summary.reported, 1);
  assert.deepEqual(summary.errors, []);
  const row = readLedger(ledgerFile(home))[0];
  assert.equal(row.status, 'stalled');
  assert.equal(row.verdict, 'stalled');
  assert.equal(row.reportedKey, 'stalled:resume-failed');
  assert.match(row.reason, /自動再開が連続2回失敗/);
  assert.equal(sheets[0].reason, row.reason);
  assert.equal(sheets[0].verdict, 'stalled');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /止まっている 1件/);
  await run({ home, now, io });
  assert.equal(sheets.length, 1);
  assert.equal(messages.length, 1);
  io.resume = async () => ({ outcome: 'error', reason: 'timeout (claude exit null):' });
  io.appendInbox = () => {};
  const later = now + 2 * 3600000;
  io.clock = () => later;
  const retried = await run({ home, now: later, io });
  assert.equal(retried.resumed, 1);
  assert.equal(sheets.length, 1);
  assert.equal(messages.length, 1);
  const failed = readLedger(ledgerFile(home))[0];
  assert.equal(failed.resumeFailureCount, 3);
  assert.equal(failed.status, 'stalled');
  io.resume = async () => ({ outcome: 'progressed', reason: '検証中' });
  io.clock = () => later + 2 * 3600000;
  await run({ home, now: later + 2 * 3600000, io });
  const recovered = readLedger(ledgerFile(home))[0];
  assert.equal(recovered.resumeFailureCount, 0);
  assert.equal(recovered.verdict, 'progressed');
  assert.equal(sheets.at(-1).verdict, 'in_progress');
});


test('失敗終了後の活動だけを数え、成功した再開の活動は保持する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-evidence-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const end = Date.parse('2026-11-02T00:00:00Z');
  const transcriptPath = path.join(home, 'session.jsonl');
  const runsDir = path.join(home, '.claude', 'auto-session', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const log = path.join(runsDir, 'run.log');
  fs.writeFileSync(log, 'session-test');
  fs.utimesSync(log, new Date(end), new Date(end));
  const row = { sessionId: 'session-test', transcriptPath, ts: new Date(end - 3600000).toISOString(),
    resumedAt: new Date(end - 60000).toISOString(), lastCheckedAt: new Date(end).toISOString(),
    resumeFinishedAt: new Date(end).toISOString(), resumeCount: 2, resumeOutcome: 'error: timeout (claude exit null):' };
  const message = at => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: '作業を進めています' } });
  fs.writeFileSync(transcriptPath, message(end));
  let evidence = gatherEvidence(row, home);
  assert.equal(evidence.any, false);
  assert.equal(judge(row, evidence, end).verdict, 'stalled');
  for (const resumeOutcome of ['progressed: 検証中', 'done: 完了']) {
    const success = { ...row, resumeOutcome };
    evidence = gatherEvidence(success, home);
    assert.equal(evidence.transcript.count, 1);
    assert.equal(judge(success, evidence, end, { askLlm: () => null }).verdict, 'in_progress');
  }
  fs.appendFileSync(transcriptPath, '\n' + message(end + 1000));
  evidence = gatherEvidence({ ...row, lastCheckedAt: new Date(end + 10000).toISOString() }, home);
  assert.equal(evidence.transcript.count, 1);
  assert.equal(judge(row, evidence, end + 10000, { askLlm: () => null }).verdict, 'in_progress');
  fs.writeFileSync(transcriptPath, message(end));
  fs.utimesSync(log, new Date(end + 1000), new Date(end + 1000));
  evidence = gatherEvidence(row, home);
  assert.equal(evidence.runs.names.length, 1);
  assert.equal(judge(row, evidence, end + 10000, { askLlm: () => null }).verdict, 'in_progress');
});


test('終了後の本人発言を数え、総再開回数と連続失敗回数を区別する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-user-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const end = Date.parse('2026-11-02T00:00:00Z');
  const transcriptPath = path.join(home, 'session.jsonl');
  const row = { transcriptPath, ts: new Date(end - 3600000).toISOString(),
    resumedAt: new Date(end - 60000).toISOString(), resumeFinishedAt: new Date(end).toISOString(),
    resumeCount: 7, resumeFailureCount: 1, resumeOutcome: 'blocked: 検証失敗' };
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'user', timestamp: new Date(end + 1000).toISOString(),
    message: { content: '続けてください' } }));
  const evidence = gatherEvidence(row, home);
  assert.equal(evidence.transcript.count, 1);
  assert.equal(judge({ ...row, resumeFailureCount: 2 }, evidence, end + 2000, { askLlm: () => null }).verdict, 'in_progress');
  const stalled = judge(row, { any: false, lastEvidenceAt: 0 }, end + 2000);
  assert.equal(stalled.verdict, 'stalled');
  assert.equal(stalled.source, 'deterministic');
});

test('完了通知は DM 成功時もローカル user にトーストを送る', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-toast-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-11-02T10:00:00Z');
  writeLedger(ledgerFile(home), [{
    ts: new Date(now - 2 * 3600000).toISOString(), pc: 'test-pc', user: 'test', owner: 'kim@orgiast.jp',
    sessionId: 'done-toast-test', cwd: home, promise: 'Xの投稿を読み調査結果をまとめます',
    status: 'done', verdict: 'done', doneAt: new Date(now - 60000).toISOString(),
  }]);
  let toastCalls = 0; let toastText = '';
  const io = {
    clock: () => now, transcriptFiles: [], sheetConfig: () => null,
    localOwner: 'kim@orgiast.jp',
    notifyOwner: async () => ({ delivered: 'dm', messageId: 'receipt' }),
    sendOwnerToast: async (text) => { toastCalls++; toastText = text; return true; },
    digest: async () => ({}),
  };
  const summary = await run({ home, now, io });
  assert.ok(summary.doneNotifications.recent >= 1);
  assert.equal(toastCalls, 1);
  assert.ok(toastText.startsWith('✅ 自動進行が完了'));
  assert.ok(toastText.includes('Xの投稿を読み調査結果をまとめます'));
});

test('バックログ完了通知もローカル user にトーストを送る', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-toast-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-11-02T10:00:00Z');
  writeLedger(ledgerFile(home), [{
    ts: new Date(now - 100 * 3600000).toISOString(), pc: 'test-pc', user: 'test', owner: 'kim@orgiast.jp',
    sessionId: 'backlog-toast-test', cwd: home, promise: 'Xの投稿を読み調査結果をまとめます',
    status: 'done', verdict: 'done', doneAt: new Date(now - 73 * 3600000).toISOString(),
  }]);
  let toastCalls = 0; let toastText = '';
  const io = {
    clock: () => now, transcriptFiles: [], sheetConfig: () => null,
    localOwner: 'kim@orgiast.jp',
    notifyOwner: async () => ({ delivered: 'dm', messageId: 'receipt' }),
    sendOwnerToast: async (text) => { toastCalls++; toastText = text; return true; },
    digest: async () => ({}),
  };
  const summary = await run({ home, now, io });
  assert.ok(summary.doneNotifications.backlog >= 1);
  assert.equal(toastCalls, 1);
  assert.ok(toastText.startsWith('✅ 自動進行が完了'));
});

test('巡回末尾の督促へhome/時刻/dry-runを渡し、失敗も巡回を落とさない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-escalate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-11-04T10:00:00Z');
  for (const dryRun of [false, true]) {
    const order = [];
    const result = await run({ home, now, dryRun, io: {
      transcriptFiles: [], sheetConfig: () => null,
      digest: async () => { order.push('digest'); return { sent: false }; },
      escalateKimDecisions: async options => {
        assert.equal(options.home, home);
        assert.equal(options.now, now);
        assert.equal(options.dryRun, dryRun);
        order.push('escalate');
        throw new Error('mock failure');
      },
    } });
    assert.deepEqual(order, dryRun ? ['escalate'] : ['digest', 'escalate']);
    assert.ok(result.errors.includes('escalate: mock failure'));
  }
});
