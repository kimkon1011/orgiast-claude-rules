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

test('timeoutを繰り返した実例は上限到達後にSheetとDMまとめへ一度報告される', async t => {
  const { MAX_RESUMES } = await import('./auto-progress-watch.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-exhausted-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-11-02T00:00:00Z');
  writeLedger(ledgerFile(home), [{
    sessionId: '28c97712-092f-42d5-8f40-3efeb5ed3ef3', ts: new Date(now - 4 * 3600000).toISOString(),
    pc: 'test-pc', user: 'test', owner: 'kim', cwd: home, promise: 'Xの投稿を読み調査結果をまとめます',
    status: 'resumed', verdict: 'in_progress', reason: '判定AIが使えず様子見', nextKim: 'なし',
    resumeCount: MAX_RESUMES, resumedAt: new Date(now - 60000).toISOString(),
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
  assert.equal(row.reportedKey, `stalled:true:${MAX_RESUMES}:resume-exhausted`);
  assert.equal(sheets[0].reason, row.reason);
  assert.equal(sheets[0].verdict, 'stalled');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /止まっている 1件/);
  await run({ home, now, io });
  assert.equal(sheets.length, 1);
  assert.equal(messages.length, 1);
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
