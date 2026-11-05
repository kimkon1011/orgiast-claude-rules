import { progressHome, notificationMocks } from './test-helpers/auto-progress-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { legacyAddCheckMigrationRows, formatDoneLine, formatDoneMessage, formatDoneBacklogMessages, gatherEvidence, deterministicVerdict, judge, evidenceSummary, logDoneDm, run as runWatch } from './auto-progress-watch.mjs';
import { cleanupOldLedgerTemps, ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';
import { listItems } from './kim-inbox.mjs';

const run = options => runWatch({ ...options, io: { ...notificationMocks, ...options.io } });

test('kim の recent/backlog 完了は静穏時間も保存・読み戻しし、旧通知済み印を救済する', async t => {
  const home = progressHome('kim-done-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'seisaku-team@orgiast.jp' } }));
  const now = Date.parse('2026-11-04T16:00:00Z');
  writeLedger(ledgerFile(home), [1, 100].map(hours => ({ sessionId: `job-${hours}`, status: 'done',
    ts: new Date(now - hours * 3600000).toISOString(), doneAt: new Date(now - hours * 3600000).toISOString(),
    doneNotifiedAt: new Date(now - 1000).toISOString(), promise: '作業', reason: '成果物を検証済み' })));
  let failRead = true;
  const io = { clock: () => now, transcriptFiles: [], sheetConfig: () => null, digest: async () => ({}), escalateKimDecisions: async () => ({}),
    listKimInboxItems: home => failRead ? [] : listItems(home), notifyOwner: () => assert.fail('no Discord') };
  const failed = await run({ home, now, io });
  assert.equal(failed.errors.length, 2);
  assert.ok(readLedger(ledgerFile(home)).every(row => !row.doneInboxVerifiedAt));
  failRead = false;
  assert.deepEqual((await run({ home, now, io })).errors, []);
  assert.ok(readLedger(ledgerFile(home)).every(row => row.doneInboxId && row.doneInboxVerifiedAt));
  await run({ home, now, io });
  assert.equal(listItems(home).length, 2);
});

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
  const home = progressHome('done-notice-');
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
  const home = progressHome('ledger-retry-');
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
  const home = progressHome('ledger-failure-');
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
  const home = progressHome('ledger-cleanup-');
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
  const home = progressHome('done-dm-log-');
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
  const home = progressHome('resume-exhausted-');
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
  const home = progressHome('resume-evidence-');
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
  const home = progressHome('resume-user-');
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
  const home = progressHome('done-toast-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-11-02T10:00:00Z');
  writeLedger(ledgerFile(home), [{
    ts: new Date(now - 2 * 3600000).toISOString(), pc: 'test-pc', user: 'test', owner: 'staff@example.test',
    sessionId: 'done-toast-test', cwd: home, promise: 'Xの投稿を読み調査結果をまとめます',
    status: 'done', verdict: 'done', doneAt: new Date(now - 60000).toISOString(),
  }]);
  let toastCalls = 0; let toastText = '';
  const io = {
    clock: () => now, transcriptFiles: [], sheetConfig: () => null,
    localOwner: 'staff@example.test',
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
  const home = progressHome('backlog-toast-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-11-02T10:00:00Z');
  writeLedger(ledgerFile(home), [{
    ts: new Date(now - 100 * 3600000).toISOString(), pc: 'test-pc', user: 'test', owner: 'staff@example.test',
    sessionId: 'backlog-toast-test', cwd: home, promise: 'Xの投稿を読み調査結果をまとめます',
    status: 'done', verdict: 'done', doneAt: new Date(now - 73 * 3600000).toISOString(),
  }]);
  let toastCalls = 0; let toastText = '';
  const io = {
    clock: () => now, transcriptFiles: [], sheetConfig: () => null,
    localOwner: 'staff@example.test',
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
  const home = progressHome('watch-escalate-');
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

// 実例と同じ metadata を持つ定期ターン。各時刻は now からの経過時間。
function scheduledFixture(t) {
  const home = progressHome('scheduled-evidence-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-11-04T10:00:00Z');
  const transcriptPath = path.join(home, 'session.jsonl');
  const entry = (hours, type, content, extra = {}) => ({ type,
    timestamp: new Date(now - hours * 3600000).toISOString(), message: { role: type, content }, ...extra });
  const lines = [entry(30, 'user', 'Muse 提案を作ってください'), entry(29, 'assistant', '調査を進めます')];
  for (const hours of [5, 3, 1]) {
    lines.push(entry(hours, 'user', '[定期進捗チェック: 28c97712] 進捗を確認', {
      isMeta: true, promptSource: 'system', wakeupSource: 'schedule_wakeup', turnOrigin: 'scheduled',
    }), entry(hours - 0.01, 'assistant', '確認しました。引き続き進めます'));
  }
  const save = () => fs.writeFileSync(transcriptPath, lines.map(line => JSON.stringify(line)).join('\n'));
  save();
  const row = { sessionId: '28c97712-scheduled-test', transcriptPath, cwd: home, owner: 'kim',
    ts: new Date(now - 31 * 3600000).toISOString(), promise: 'Muse 提案を作成します', status: 'open',
    deadlineAt: new Date(now + 24 * 3600000).toISOString() };
  return { home, now, row, lines, entry, save };
}

test('期限前でも2時間ごとの定期確認3回だけでは24時間以上の停滞を解消しない', async t => {
  const f = scheduledFixture(t);
  const evidence = gatherEvidence(f.row, f.home);
  assert.equal(evidence.transcript.count, 1);
  assert.equal(evidence.transcript.ignoredScheduledCount, 6);
  assert.equal(evidence.lastEvidenceAt, f.now - 29 * 3600000);
  const result = judge(f.row, evidence, f.now, { askLlm: () => null });
  assert.equal(result.verdict, 'stalled');
  assert.match(result.reason, /定期確認のみで進捗なし/);
  writeLedger(ledgerFile(f.home), [f.row]);
  const sheets = [];
  const io = { clock: () => f.now, transcriptFiles: [], sheetConfig: () => ({}), cwdExists: () => false,
    askLlm: () => null, postSheet: async (_config, _tab, payload) => sheets.push(payload.row),
    digest: async () => ({}), escalateKimDecisions: async () => ({}) };
  const summary = await run({ home: f.home, now: f.now, io });
  assert.equal(summary.stalled, 1);
  assert.equal(summary.inProgress, 0);
  assert.deepEqual(summary.errors, []);
  assert.equal(readLedger(ledgerFile(f.home))[0].verdict, 'stalled');
  await run({ home: f.home, now: f.now, io });
  assert.equal(sheets.length, 1);
});

test('各定期 metadata を単独で判定し、cutoff前の起点とtool結果を追跡する', t => {
  const f = scheduledFixture(t);
  for (const metadata of [{ turnOrigin: 'scheduled' }, { wakeupSource: 'schedule_wakeup' }]) {
    f.lines.splice(0, f.lines.length,
      f.entry(3, 'user', '確認', metadata),
      f.entry(1, 'assistant', [{ type: 'tool_use', name: 'Write', input: { file_path: f.row.transcriptPath } }]),
      f.entry(0.9, 'user', [{ type: 'tool_result', content: 'ok' }]),
      f.entry(0.8, 'user', '補助情報', { isMeta: true }),
      f.entry(0.7, 'queue-operation', 'queue'), f.entry(0.6, 'attachment', 'attachment'),
      f.entry(0.5, 'assistant', '確認完了'));
    f.save();
    const row = { ...f.row, resumeOutcome: 'error: timeout', resumeCount: 2,
      resumeFinishedAt: new Date(f.now - 2 * 3600000).toISOString() };
    const evidence = gatherEvidence(row, f.home);
    assert.equal(evidence.any, false);
    assert.deepEqual(evidence.transcript.touchedPaths, []);
    assert.equal(evidence.transcript.ignoredScheduledCount, 4);
    const verdict = judge(row, evidence, f.now, { askLlm: () => assert.fail('定期確認は再開失敗を解除しない') });
    assert.equal(verdict.source, 'resume-failed');
    assert.match(verdict.reason, /定期確認のみで進捗なし/);
    f.lines.push(f.entry(0.1, 'user', '続けてください'));
    f.save();
    const human = gatherEvidence(row, f.home);
    assert.equal(human.transcript.count, 1);
    assert.equal(judge(row, human, f.now, { askLlm: () => null }).verdict, 'in_progress');
    f.lines.push(f.entry(0.05, 'assistant', '調査を再開しました'));
    f.save();
    assert.equal(gatherEvidence(row, f.home).transcript.count, 2);
  }
});

test('バックグラウンド完了通知（promptSource:system）は定期扱いせず、その後の作業を数える', t => {
  const f = scheduledFixture(t);
  f.lines.splice(0, f.lines.length,
    f.entry(1, 'user', '<task-notification>完了</task-notification>', { promptSource: 'system', turnOrigin: 'task_notification' }),
    f.entry(0.9, 'assistant', 'Codex の差分を確認します'));
  f.save();
  const evidence = gatherEvidence(f.row, f.home);
  assert.equal(evidence.transcript.ignoredScheduledCount, 0);
  assert.equal(evidence.transcript.count, 1);
});

test('isMetaだけでは定期扱いせず、queueとattachmentは活動に数えない', t => {
  const f = scheduledFixture(t);
  f.lines.splice(0, f.lines.length, f.entry(1, 'user', '補助情報', { isMeta: true }),
    f.entry(0.9, 'assistant', '調査中'), f.entry(0.8, 'queue-operation', 'queue'), f.entry(0.7, 'attachment', 'attachment'));
  f.save();
  const evidence = gatherEvidence(f.row, f.home);
  assert.equal(evidence.transcript.count, 1);
  assert.equal(evidence.transcript.ignoredScheduledCount, 0);
  assert.equal(evidence.lastEvidenceAt, f.now - 0.9 * 3600000);
});

test('定期ターン中でもcheckが達成なら従来どおりdoneにする', async t => {
  const f = scheduledFixture(t);
  fs.writeFileSync(path.join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  writeLedger(ledgerFile(f.home), [{ ...f.row, check: 'mock check' }]);
  const summary = await run({ home: f.home, now: f.now, io: {
    clock: () => f.now, transcriptFiles: [], sheetConfig: () => null,
    executeCheck: () => ({ code: 0, text: 'Muse 提案の成果物を確認' }),
    notifyOwner: async () => ({ delivered: 'dm' }), digest: async () => ({}), escalateKimDecisions: async () => ({}),
  } });
  assert.equal(summary.done, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(readLedger(ledgerFile(f.home))[0].status, 'done');
});

test('同一セッションの異なる label の check を両方評価する', async t => {
  const home = progressHome('multi-check-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  const now = Date.parse('2026-10-29T11:00:00.000Z');
  const base = { pc: 'test-pc', user: 'test', owner: 'kim@orgiast.jp', sessionId: 'session-1', cwd: home,
    promise: '機器設定を確認する', status: 'open', check: 'mock check', deadlineAt: new Date(now + 3600000).toISOString() };
  writeLedger(ledgerFile(home), [
    { ...base, label: 'NVIDIAドライバー582.78更新', ts: '2026-10-29T10:00:00.000Z' },
    { ...base, label: 'HDMIダミープラグ取り付け', ts: '2026-10-29T10:00:02.000Z' },
  ]);
  const evaluated = [];
  const summary = await run({ home, now, io: {
    clock: () => now, transcriptFiles: [], sheetConfig: () => null,
    executeCheck: row => { evaluated.push(row.label); return { code: 1, text: '未達成' }; },
    digest: async () => ({}), escalateKimDecisions: async () => ({}),
  } });
  assert.deepEqual(evaluated, ['NVIDIAドライバー582.78更新', 'HDMIダミープラグ取り付け']);
  assert.equal(summary.checked, 2);
  assert.deepEqual(readLedger(ledgerFile(home)).map(row => row.status), ['open', 'open']);
});

test('レシート済み完了は legacy add-check 移行で復活させない', () => {
  const base = { pc: 'PC1', user: 'user', sessionId: 's-receipt', ts: '2026-11-05T10:00:00.000Z',
    status: 'done', check: 'node check.mjs', nextClaude: 'x' };
  const withReceipt = { ...base, doneInboxId: 'ki-1', doneInboxVerifiedAt: '2026-11-05T11:00:00.000Z', doneNotifiedAt: '2026-11-05T11:00:00.000Z' };
  const notifiedOnly = { ...base, ts: '2026-11-05T10:05:00.000Z', doneInboxId: '', doneInboxVerifiedAt: '', doneNotifiedAt: '2026-11-05T11:05:00.000Z' };
  const noReceipt = { ...base, ts: '2026-11-05T10:10:00.000Z', doneInboxId: '', doneInboxVerifiedAt: '', doneNotifiedAt: '' };
  const rows = [withReceipt, notifiedOnly, noReceipt];
  assert.deepEqual(legacyAddCheckMigrationRows(rows), [noReceipt]);
});
