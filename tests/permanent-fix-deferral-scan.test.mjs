import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scan } from '../tools/permanent-fix-deferral-scan.mjs';

function jsonl(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
}

function fixture(t, sessionId, transcript) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const projectsDir = path.join(root, 'projects');
  const ts = '2026-11-19T18:06:00.000Z';
  jsonl(path.join(home, '.claude', 'handoff-audit-ledger.jsonl'), [
    { ts, sessionId, excerpt: 'Codex の完了通知を待っています' }
  ]);
  if (transcript) jsonl(path.join(projectsDir, 'project-a', `${sessionId}.jsonl`), transcript);
  return { home, projectsDir };
}

test('notification の後に assistant text があれば W を集計から除外する', t => {
  const { home, projectsDir } = fixture(t, 'resolved', [
    { type: 'user', timestamp: '2026-11-19T18:08:04.000Z', message: { content: '<task-notification>done</task-notification>' } },
    { type: 'assistant', timestamp: '2026-11-19T18:09:00.000Z', message: { content: [{ type: 'text', text: 'PR #2443 を作成しました。' }] } }
  ]);
  const originalProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = projectsDir;
  t.after(() => {
    if (originalProjectsDir === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = originalProjectsDir;
  });

  const source = scan({ home }).sources[1];
  assert.equal(source.hits, 0);
  assert.equal(source.byPattern.W, 0);
  assert.deepEqual(source.byDay, {});
  assert.equal(source.rows[0].resolved, 'in-session');
});

test('notification の後に assistant text がなければ W を数える', t => {
  const { home, projectsDir } = fixture(t, 'notification-only', [
    { type: 'user', timestamp: '2026-11-19T18:08:04.000Z', message: { content: '<task-notification>done</task-notification>' } }
  ]);

  const source = scan({ home, projectsDir }).sources[1];
  assert.equal(source.hits, 1);
  assert.equal(source.byPattern.W, 1);
  assert.deepEqual(source.byDay, { '2026-11-19': 1 });
  assert.equal(source.rows[0].resolved, undefined);
});

test('transcript がなければ unknown を付けて W を数える', t => {
  const { home, projectsDir } = fixture(t, 'missing');

  const source = scan({ home, projectsDir }).sources[1];
  assert.equal(source.hits, 1);
  assert.equal(source.byPattern.W, 1);
  assert.deepEqual(source.byDay, { '2026-11-19': 1 });
  assert.equal(source.rows[0].resolved, 'unknown');
});

function archiveFixture(t, sessionId, transcript) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const projectsDir = path.join(root, 'projects');
  const archiveDir = path.join(root, 'projects-archive');
  const ts = '2026-11-19T18:06:00.000Z';
  jsonl(path.join(home, '.claude', 'handoff-audit-ledger.jsonl'), [
    { ts, sessionId, excerpt: 'Codex の完了通知を待っています' }
  ]);
  if (transcript) jsonl(path.join(archiveDir, 'project-a', `${sessionId}.jsonl`), transcript);
  return { home, projectsDir, archiveDir };
}

function bothFixture(t, sessionId, projectsTranscript, archiveTranscript) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const projectsDir = path.join(root, 'projects');
  const archiveDir = path.join(root, 'projects-archive');
  const ts = '2026-11-19T18:06:00.000Z';
  jsonl(path.join(home, '.claude', 'handoff-audit-ledger.jsonl'), [
    { ts, sessionId, excerpt: 'Codex の完了通知を待っています' }
  ]);
  if (projectsTranscript) jsonl(path.join(projectsDir, 'project-a', `${sessionId}.jsonl`), projectsTranscript);
  if (archiveTranscript) jsonl(path.join(archiveDir, 'project-a', `${sessionId}.jsonl`), archiveTranscript);
  return { home, projectsDir, archiveDir };
}

test('archive にだけ transcript があり完了通知 → W を集計から除外する', t => {
  const { home, projectsDir, archiveDir } = archiveFixture(t, 'archived-resolved', [
    { type: 'user', timestamp: '2026-11-19T18:08:04.000Z', message: { content: '<task-notification>done</task-notification>' } },
    { type: 'assistant', timestamp: '2026-11-19T18:09:00.000Z', message: { content: [{ type: 'text', text: '完了しました。' }] } }
  ]);

  const source = scan({ home, projectsDir, archiveDir }).sources[1];
  assert.equal(source.hits, 0);
  assert.equal(source.byPattern.W, 0);
  assert.equal(source.rows[0].resolved, 'in-session');
});

test('projects と archive の両方にある → projects 側を使う', t => {
  const { home, projectsDir, archiveDir } = bothFixture(t, 'both-session',
    // projects: notification only → not resolved
    [
      { type: 'user', timestamp: '2026-11-19T18:08:04.000Z', message: { content: '<task-notification>done</task-notification>' } }
    ],
    // archive: notification + assistant text → would be resolved if used
    [
      { type: 'user', timestamp: '2026-11-19T18:08:04.000Z', message: { content: '<task-notification>done</task-notification>' } },
      { type: 'assistant', timestamp: '2026-11-19T18:09:00.000Z', message: { content: [{ type: 'text', text: '完了しました。' }] } }
    ]
  );

  const source = scan({ home, projectsDir, archiveDir }).sources[1];
  // projects 側を使うので notification only → resolved=false → W を数える
  assert.equal(source.hits, 1);
  assert.equal(source.byPattern.W, 1);
  assert.equal(source.rows[0].resolved, undefined);
});

test('archive ディレクトリが存在しない → 例外なく従来どおり', t => {
  const { home, projectsDir } = fixture(t, 'missing-archive');
  const nonexistentDir = path.join(os.tmpdir(), 'nonexistent-archive-' + Date.now());

  // 例外が発生しないことを確認
  const source = scan({ home, projectsDir, archiveDir: nonexistentDir }).sources[1];
  assert.equal(source.hits, 1);
  assert.equal(source.byPattern.W, 1);
  assert.equal(source.rows[0].resolved, 'unknown');
});
