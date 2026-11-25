import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectProjectInventory, extractCwd, formatArtifactsCell, formatLastCommitCell,
  formatProjectsCell, pickActiveBuckets, summarizeProjects,
} from './project-inventory.mjs';

const NOW = new Date('2026-08-28T12:00:00.000Z');

test('pickActiveBuckets: 注入したnowから7日以内だけを新しい順に選ぶ', () => {
  const entries = [
    { name: 'old', mtimeMs: new Date('2026-08-20T11:59:59Z').getTime() },
    { name: 'new', mtimeMs: new Date('2026-08-28T10:00:00Z').getTime() },
    { name: 'edge', mtimeMs: new Date('2026-08-21T12:00:00Z').getTime() },
  ];
  assert.deepEqual(pickActiveBuckets(entries, NOW, 7).map((entry) => entry.name), ['new', 'edge']);
});

test('extractCwd: 実物形状のWindows/POSIX transcriptからcwdフィールドだけを抽出', () => {
  const windows = '{"type":"user","message":{"content":"会話は読まない"},"cwd":"C:\\\\Users\\\\x\\\\Downloads\\\\proj"}\n';
  const posix = '{"type":"assistant","cwd":"/home/x/proj","prompt":"secret"}\n';
  assert.equal(extractCwd(windows), 'C:\\Users\\x\\Downloads\\proj');
  assert.equal(extractCwd(posix), '/home/x/proj');
});

test('整形純関数: 活動順・最大件数・60文字制限', () => {
  const items = [
    { project: 'a', repoName: 'ra', branch: 'main', commits: 1, lastCommitAt: '2026-08-27', lastCommitSubject: 'x'.repeat(61) },
    { project: 'b', repoName: 'rb', branch: 'dev', commits: 3, lastCommitAt: '2026-08-26', lastCommitSubject: 'second' },
  ];
  const result = summarizeProjects(items, 1);
  assert.equal(formatProjectsCell(result), 'b(3)');
  assert.equal(formatArtifactsCell(items), 'ra@main, rb@dev');
  assert.equal(formatLastCommitCell(items), `2026-08-27 ${'x'.repeat(60)}`);
});

test('実物形状fixture + 注入Git: Windows/POSIXを収集し全項目が空でない', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-project-inventory-'));
  const projectsDir = path.join(root, '.claude', 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const fixtures = [
    ['bucket-win', '{"type":"user","message":{"content":"本文"},"cwd":"C:\\\\Users\\\\x\\\\Downloads\\\\win-proj"}\n', '2026-08-28T10:00:00Z'],
    ['bucket-posix', '{"type":"assistant","cwd":"/home/x/posix-proj","prompt":"secret"}\n', '2026-08-27T10:00:00Z'],
  ];
  for (const [bucket, text, timestamp] of fixtures) {
    const dir = path.join(projectsDir, bucket); fs.mkdirSync(dir);
    const file = path.join(dir, 'session.jsonl'); fs.writeFileSync(file, text);
    fs.utimesSync(file, new Date(timestamp), new Date(timestamp));
  }
  const runGit = (_cwd, args) => {
    const key = args.join(' ');
    const values = new Map([
      ['rev-parse --is-inside-work-tree', 'true'], ['remote get-url origin', 'git@github.com:org/repository.git'],
      ['branch --show-current', 'main'], ['log -1 --format=%cs%x00%s', '2026-08-28\0実物形状テスト'],
      ['config user.email', 'dev@example.com'],
    ]);
    if (args[0] === 'log' && args.includes('--format=%H')) return { ok: true, stdout: 'a1\nb2', error: '' };
    return { ok: values.has(key), stdout: values.get(key) || '', error: '' };
  };
  const items = collectProjectInventory({ projectsDir, now: NOW, days: 7, limit: 5, runGit, warn: () => {} });
  assert.equal(items.length, 2);
  for (const item of items) for (const key of ['project', 'repoName', 'branch', 'lastCommitAt', 'lastCommitSubject']) assert.notEqual(item[key], '', `${item.project}.${key}`);
  assert(items.every((item) => Number.isFinite(item.commits)));
  assert.deepEqual(new Set(items.map((item) => item.project)), new Set(['win-proj', 'posix-proj']));
});
