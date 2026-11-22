import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detect, scan } from '../tools/permanent-fix-deferral-scan.mjs';

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

test('待機語を含む節が作業なしの否定で終わる場合は W にしない', () => {
  const text = 'タブは開けていません。普段の起動先は VSCode です（vscode・有効） | このセッションで新たに止まっている作業や、金さんを待っている作業はありません';
  assert.equal(detect(text).some(hit => hit.pattern === 'W'), false);
});

test('別セッションの待機文を引用した検証表は W にしない', () => {
  const text = 'いう報告はない | | 3da37415 | 74a11b05 | **実再発** | 「Codex の作業が終わるのを待っています」のあと、完了通知も応答もな';
  assert.equal(detect(text).some(hit => hit.pattern === 'W'), false);
});

test('別セッションの待機文を引用した完了報告は W にしない', () => {
  const text = '【最終まとめ】 ① 報告 212coffee の無料掲載の準備（11/21 に「Codex の作業が終わるのを待っています」で止まったセッション 74a11b05';
  assert.equal(detect(text).some(hit => hit.pattern === 'W'), false);
});

test('実際に継続している待機文は W のまま検出する', () => {
  const texts = [
    'Codex がテスト・PR 着地・読み戻しを進めています。終わると自動で通知が来るので、それまで待ちます。',
    '公式ページの確認結果が届くのを待っています。届いたらマニュアルと移行計画を書き上げます。',
    '完了通知がまだ来ていません。届いたら締めます。'
  ];
  for (const text of texts) assert.equal(detect(text).some(hit => hit.pattern === 'W'), true, text);
});
