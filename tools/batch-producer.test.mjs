import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { produce } from './batch-producer.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-producer-'));
  const project = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'open-session.jsonl'), '{"type":"user","message":"未完了を直す"}\n');
  return home;
}

function writeFile(home, rel, body) {
  const file = path.join(home, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function setMtime(file, date) {
  fs.utimesSync(file, date, date);
}

test('同じ日の未クローズセッション要約を二重投入しない', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  assert.equal(produce({ home, now, sessionSummaryEnabled: true }).filter((job) => job.jobType === 'unclosed-session-summary').length, 1);
  assert.equal(produce({ home, now, sessionSummaryEnabled: true }).length, 0);
  const pending = fs.readFileSync(path.join(home, '.claude', 'batch-queue', 'pending.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(pending.filter((job) => job.jobType === 'unclosed-session-summary').length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('既定ではセッション要約を積まずスキップ理由を残す', () => {
  const home = fixture();
  const made = produce({ home, now: new Date('2026-08-28T12:00:00Z'), sessionSummaryEnabled: false });
  assert.ok(!made.some((job) => job.jobType === 'unclosed-session-summary'));
  assert.ok(made.skipped.includes('unclosed-session-summary(既定OFF)'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('明示的に有効化した場合だけセッション要約を積む', () => {
  const home = fixture();
  const made = produce({ home, now: new Date('2026-08-28T12:00:00Z'), sessionSummaryEnabled: true });
  assert.ok(made.some((job) => job.jobType === 'unclosed-session-summary'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('ORGIAST_BATCH_SESSION_SUMMARY=1 のときだけ既定引数でセッション要約を積む', () => {
  const previous = process.env.ORGIAST_BATCH_SESSION_SUMMARY;
  const homeOff = fixture();
  const homeOn = fixture();
  try {
    delete process.env.ORGIAST_BATCH_SESSION_SUMMARY;
    assert.ok(!produce({ home: homeOff, now: new Date('2026-08-28T12:00:00Z') }).some((job) => job.jobType === 'unclosed-session-summary'));
    process.env.ORGIAST_BATCH_SESSION_SUMMARY = '1';
    assert.ok(produce({ home: homeOn, now: new Date('2026-08-28T12:00:00Z') }).some((job) => job.jobType === 'unclosed-session-summary'));
  } finally {
    if (previous === undefined) delete process.env.ORGIAST_BATCH_SESSION_SUMMARY;
    else process.env.ORGIAST_BATCH_SESSION_SUMMARY = previous;
    fs.rmSync(homeOff, { recursive: true, force: true });
    fs.rmSync(homeOn, { recursive: true, force: true });
  }
});

test('既定OFFでもバッチ結果の日次ダイジェストは積む', () => {
  const home = fixture();
  const queue = path.join(home, '.claude', 'batch-queue');
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(queue, 'results-2026-08-27.jsonl'), `${JSON.stringify({ id: 'result', jobType: 'other', text: '成果' })}\n`);
  const made = produce({ home, now: new Date('2026-08-28T12:00:00Z'), sessionSummaryEnabled: false });
  assert.ok(made.some((job) => job.jobType === 'results-daily-digest'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('当日のresultsに同種があればpendingが空でも再投入しない', () => {
  const home = fixture();
  const queue = path.join(home, '.claude', 'batch-queue');
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(queue, 'results-2026-08-28.jsonl'), `${JSON.stringify({ id: 'done', jobType: 'unclosed-session-summary', batchDate: '2026-08-28', text: '済' })}\n`);
  const made = produce({ home, now: new Date('2026-08-28T12:00:00Z') });
  assert.ok(!made.some((job) => job.jobType === 'unclosed-session-summary'));
  assert.ok(made.some((job) => job.jobType === 'results-daily-digest'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('executor-usage-digest: 直近24時間のデータで1件積まれる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  const oneHourAgo = new Date(now.getTime() - 3600000);
  
  writeFile(home, '.claude/executor-usage.jsonl', 
    `${JSON.stringify({t: oneHourAgo.toISOString(), provider: 'groq', model: 'm', in: 100, out: 50, secs: 1, status: 'ok'})}\n` +
    `${JSON.stringify({t: oneHourAgo.toISOString(), provider: 'groq', model: 'm', in: 200, out: 100, secs: 2, status: 'ok'})}\n`
  );
  
  const made = produce({ home, now });
  const digestJob = made.find(job => job.jobType === 'executor-usage-digest');
  
  assert.ok(digestJob);
  assert.equal(digestJob.provider, 'deepseek');
  assert.ok(digestJob.prompt.includes('"calls":2'));
  assert.ok(digestJob.prompt.includes('"in":300'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('executor-usage-digest: 24時間より古いデータではスキップされる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400000);
  
  writeFile(home, '.claude/executor-usage.jsonl', 
    `${JSON.stringify({t: twoDaysAgo.toISOString(), provider: 'groq', model: 'm', in: 100, out: 50, secs: 1, status: 'ok'})}\n`
  );
  
  const made = produce({ home, now });
  assert.ok(!made.some(job => job.jobType === 'executor-usage-digest'));
  assert.ok(made.skipped.includes('executor-usage-digest(データ無し)'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('executor-usage-digest: ファイルがない場合はスキップされる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  
  const made = produce({ home, now });
  assert.ok(!made.some(job => job.jobType === 'executor-usage-digest'));
  assert.ok(made.skipped.includes('executor-usage-digest(データ無し)'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('executor-usage-digest: 2回目の呼び出しでは積まれない', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  const oneHourAgo = new Date(now.getTime() - 3600000);
  
  writeFile(home, '.claude/executor-usage.jsonl', 
    `${JSON.stringify({t: oneHourAgo.toISOString(), provider: 'groq', model: 'm', in: 100, out: 50, secs: 1, status: 'ok'})}\n`
  );
  
  const firstCall = produce({ home, now });
  assert.equal(firstCall.filter(job => job.jobType === 'executor-usage-digest').length, 1);
  
  const secondCall = produce({ home, now });
  assert.equal(secondCall.filter(job => job.jobType === 'executor-usage-digest').length, 0);
  
  const pending = fs.readFileSync(path.join(home, '.claude', 'batch-queue', 'pending.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.equal(pending.filter(job => job.jobType === 'executor-usage-digest').length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('auto-session-digest: 要約ファイルがある場合は1件積まれる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  const oneHourAgo = new Date(now.getTime() - 3600000);
  
  writeFile(home, '.claude/auto-session/runs/2026-08-28-1.summary.md', '自動セッションの要約内容です。');
  const summaryFile = path.join(home, '.claude', 'auto-session', 'runs', '2026-08-28-1.summary.md');
  setMtime(summaryFile, oneHourAgo);
  
  const made = produce({ home, now });
  const digestJob = made.find(job => job.jobType === 'auto-session-digest');
  
  assert.ok(digestJob);
  assert.ok(digestJob.prompt.includes('自動セッションの要約内容です。'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('auto-session-digest: 0バイトファイルはスキップされる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  const oneHourAgo = new Date(now.getTime() - 3600000);
  
  writeFile(home, '.claude/auto-session/runs/2026-08-28-1.summary.md', '');
  const summaryFile = path.join(home, '.claude', 'auto-session', 'runs', '2026-08-28-1.summary.md');
  setMtime(summaryFile, oneHourAgo);
  
  const made = produce({ home, now });
  assert.ok(!made.some(job => job.jobType === 'auto-session-digest'));
  assert.ok(made.skipped.includes('auto-session-digest(データ無し)'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('auto-session-digest: 24時間より古いファイルはスキップされる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400000);
  
  writeFile(home, '.claude/auto-session/runs/2026-08-26-1.summary.md', '古い要約');
  const summaryFile = path.join(home, '.claude', 'auto-session', 'runs', '2026-08-26-1.summary.md');
  setMtime(summaryFile, twoDaysAgo);
  
  const made = produce({ home, now });
  assert.ok(!made.some(job => job.jobType === 'auto-session-digest'));
  assert.ok(made.skipped.includes('auto-session-digest(データ無し)'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('auto-session-digest: 新しいファイルが古いファイルより先に現れる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  const oneHourAgo = new Date(now.getTime() - 3600000);
  const twoHoursAgo = new Date(now.getTime() - 7200000);
  
  writeFile(home, '.claude/auto-session/runs/old.summary.md', '古い要約');
  writeFile(home, '.claude/auto-session/runs/new.summary.md', '新しい要約');
  
  const oldFile = path.join(home, '.claude', 'auto-session', 'runs', 'old.summary.md');
  const newFile = path.join(home, '.claude', 'auto-session', 'runs', 'new.summary.md');
  setMtime(oldFile, twoHoursAgo);
  setMtime(newFile, oneHourAgo);
  
  const made = produce({ home, now });
  const digestJob = made.find(job => job.jobType === 'auto-session-digest');
  
  assert.ok(digestJob);
  const newIndex = digestJob.prompt.indexOf('--- new.summary.md ---');
  const oldIndex = digestJob.prompt.indexOf('--- old.summary.md ---');
  assert.ok(newIndex < oldIndex);
  fs.rmSync(home, { recursive: true, force: true });
});

test('next-session-todo-triage: TODO行がある場合は1件積まれる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  
  writeFile(home, '.claude/next-session.md', 
    '# 次のセッション\n- 残TODO A\n~~済み B~~\n見出しだけの行\n* TODO C\n'
  );
  
  const made = produce({ home, now });
  const triageJob = made.find(job => job.jobType === 'next-session-todo-triage');
  
  assert.ok(triageJob);
  assert.equal(triageJob.provider, 'groq');
  assert.equal(triageJob.max, 3000);
  assert.ok(triageJob.prompt.includes('残TODO A'));
  assert.ok(triageJob.prompt.includes('TODO C'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('next-session-todo-triage: TODO行がない場合はスキップされる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  
  writeFile(home, '.claude/next-session.md', 
    '# 次のセッション\nこれは通常の文章です。\n箇条書きではない行。\n'
  );
  
  const made = produce({ home, now });
  assert.ok(!made.some(job => job.jobType === 'next-session-todo-triage'));
  assert.ok(made.skipped.includes('next-session-todo-triage(データ無し)'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('next-session-todo-triage: 200行でも60行以内に制限される', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  
  const lines = Array.from({ length: 200 }, (_, i) => `- TODO項目${i + 1}`).join('\n');
  writeFile(home, '.claude/next-session.md', lines);
  
  const made = produce({ home, now });
  const triageJob = made.find(job => job.jobType === 'next-session-todo-triage');
  
  assert.ok(triageJob);
  const sourceMatch = triageJob.prompt.match(/以下は残TODO一覧です。([\s\S]*?)秘密値らしき文字列は出力しないでください。/);
  assert.ok(sourceMatch);
  const sourceLines = sourceMatch[1].split('\n').filter(line => line.trim().startsWith('-'));
  assert.ok(sourceLines.length <= 60);
  fs.rmSync(home, { recursive: true, force: true });
});

test('複数種別のスキップ理由が全て含まれる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  
  const made = produce({ home, now, sessionSummaryEnabled: false });
  
  assert.ok(made.skipped.includes('unclosed-session-summary(既定OFF)'));
  assert.ok(made.skipped.includes('executor-usage-digest(データ無し)'));
  assert.ok(made.skipped.includes('auto-session-digest(データ無し)'));
  assert.ok(made.skipped.includes('next-session-todo-triage(データ無し)'));
  assert.ok(made.skipped.includes('results-daily-digest(データ無し)'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('pending.jsonlに実際に書き込まれる', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  const oneHourAgo = new Date(now.getTime() - 3600000);
  
  writeFile(home, '.claude/executor-usage.jsonl', 
    `${JSON.stringify({t: oneHourAgo.toISOString(), provider: 'groq', model: 'm', in: 100, out: 50, secs: 1, status: 'ok'})}\n`
  );
  
  writeFile(home, '.claude/next-session.md', 
    '# 次のセッション\n- 残TODO A\n- TODO B\n'
  );
  
  const made = produce({ home, now });
  
  const pendingFile = path.join(home, '.claude', 'batch-queue', 'pending.jsonl');
  const pendingJobs = fs.readFileSync(pendingFile, 'utf8')
    .trim().split('\n').map(JSON.parse);
  
  const jobTypes = pendingJobs.map(job => job.jobType);
  assert.ok(jobTypes.includes('executor-usage-digest'));
  assert.ok(jobTypes.includes('next-session-todo-triage'));
  
  const sampleJob = pendingJobs[0];
  assert.ok(sampleJob.id);
  assert.ok(sampleJob.provider);
  assert.ok(sampleJob.prompt);
  assert.equal(sampleJob.batchDate, '2026-08-28');
  fs.rmSync(home, { recursive: true, force: true });
});