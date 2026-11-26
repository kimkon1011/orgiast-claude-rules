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

test('表内の8桁の日付はセッションIDと扱わず W のまま検出する', () => {
  const text = '| 11/23 | 20261123 | Codex の完了を待っています |';
  assert.equal(detect(text).some(hit => hit.pattern === 'W'), true);
});

test('実際に継続している待機文は W のまま検出する', () => {
  const texts = [
    'Codex がテスト・PR 着地・読み戻しを進めています。終わると自動で通知が来るので、それまで待ちます。',
    '公式ページの確認結果が届くのを待っています。届いたらマニュアルと移行計画を書き上げます。',
    '完了通知がまだ来ていません。届いたら締めます。'
  ];
  for (const text of texts) assert.equal(detect(text).some(hit => hit.pattern === 'W'), true, text);
});

test('明示的な draft 制約と無人時の本番反映禁止は正当な承認待ちとして P3 から除外する', () => {
  const texts = [
    '作者が「この PR は draft です（マージしない）」と明記。次に kim がすること: PR #8 のマージ可否と修正の作り直し可否に答える',
    '無人セッションでは本番反映は禁止・承認待ちにする。次に kim がすること: PR #2646 のマージ可否を返す'
  ];
  for (const text of texts) assert.equal(detect(text).some(hit => hit.pattern === 'P3'), false, text);
});

test('委譲実行中で同一セッションが着地まで続ける待機は W から除外する', () => {
  const texts = [
    '修正は Codex に任せて作成中で、まだ完了していません。このセッション: まだ閉じない（作業中）',
    'Codex が background で実行中。Codex の結果を待って、PR 着地まで当セッションで進めます。',
    '委譲実行中。この後の自動進行: commit と PR 作成の完了を待ち、着地を確認する。このセッション: まだ閉じない',
    'Codex がマージ確定まで監視中。CI 監視の完了待ちです。このセッションで着地を確認して完了します。'
  ];
  for (const text of texts) assert.equal(detect(text).some(hit => hit.pattern === 'W'), false, text);
});

test('実装を次セッションの候補に残す文は P1 のまま検出する', () => {
  assert.equal(detect('恒久策（次セッションの候補として残置）: cursor-agent の hook-dispatch 問題を修正する').some(hit => hit.pattern === 'P1'), true);
});

test('未委譲のテストと PR 着地を次セッションに残す文は P1 のまま検出する', () => {
  assert.equal(detect('修正本体はコミット済み。テストの追加・テスト実行・PR の着地は次のセッションに残ります').some(hit => hit.pattern === 'P1'), true);
});

test('実データの物理的制約・枠回復・承認必須・別件起票は先送りとして検出しない', () => {
  const texts = [
    '| 5 | **45b68296a59243c6** | **真の違反** | 「恒久策（次セッションの候補として残置）」 |',
    'Edit・シェル追記のいずれもセンシティブファイル保護で拒否されました（既知の制約）。そのため次セッションの残TODO 一覧には恒久修正を残します。',
    'Codex の無人枠が 2026-11-27 00:00 JST に回復するため、次のセッションが同じ指示書で恒久修正を実装します。',
    '恒久修正の進め方を決めてください。このアプリのルールでは、文書を1つずつ承認する決まりです。',
    'PR #2812 は MERGED で着地済みです。前者は既存の判定ロジックを読んで安全性を検証しただけで、見つかった評価順序の問題の修正は次セッションの最優先TODOとして起票済みです。',
    'PR の作成とマージを CLI の直叩きで着地させました。恒久修正は次セッションの目的として登録済みです。別件としてチケット化しました。'
  ];
  for (const text of texts) assert.deepEqual(detect(text), [], text);
});

test('当初目的の完了証拠か別件証拠の片方だけでは先送りを除外しない', () => {
  const texts = [
    'PR #2812 は MERGED です。恒久修正は次セッションで対応します。',
    '新たに見つかった別件です。恒久修正は次セッションで対応します。'
  ];
  for (const text of texts) assert.equal(detect(text).some(hit => hit.pattern === 'P1'), true, text);
});

test('外的ブロッカーなしで確認を次セッションへ送る真の違反は検出し続ける', () => {
  const text = 'そのため、まとめる対象が実データ上もう残っていない可能性が高いです。**こちらの対応**: 次のセッションで「その15件が今も未回答のまま残っているか」を確認します。';
  assert.notDeepEqual(detect(text), [], text);
});

function crossSessionFixture(t, { excerpt = 'PR #2577 のマージを待っています', completedText, completedAt = '2026-11-20T18:00:00.000Z' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-cross-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const projectsDir = path.join(root, 'projects');
  jsonl(path.join(home, '.claude', 'handoff-audit-ledger.jsonl'), [
    { ts: '2026-11-19T18:00:00.000Z', sessionId: 'waiting-session', excerpt }
  ]);
  jsonl(path.join(projectsDir, 'project-a', 'waiting-session.jsonl'), [
    { type: 'assistant', timestamp: '2026-11-19T17:59:00.000Z', message: { content: [{ type: 'text', text: excerpt }] } }
  ]);
  if (completedText) jsonl(path.join(projectsDir, 'project-a', 'completed-session.jsonl'), [
    { type: 'assistant', timestamp: completedAt, message: { content: [{ type: 'text', text: completedText }] } }
  ]);
  return scan({ home, projectsDir }).sources[1];
}

test('別セッションの同じPR番号と完了語で cross-session resolved にする', t => {
  const source = crossSessionFixture(t, { completedText: 'PR #2577 はマージ済みです。' });
  assert.equal(source.hits, 0);
  assert.equal(source.byPattern.W, 0);
  assert.equal(source.rows[0].resolved, 'cross-session');
  assert.equal(source.rows[0].resolvedBy, 'completed-session');
  assert.equal(source.rows[0].identifier, 'pr:2577');
});

test('別セッションに同じPR番号だけあっても完了語なしなら起票のまま', t => {
  const source = crossSessionFixture(t, { completedText: 'PR #2577 の CI を確認中です。' });
  assert.equal(source.hits, 1);
  assert.equal(source.rows[0].resolved, undefined);
});

test('同じPRの完了報告でも72時間超なら起票のまま', t => {
  const source = crossSessionFixture(t, {
    completedText: 'PR #2577 はマージ済みです。',
    completedAt: '2026-11-22T18:00:00.001Z'
  });
  assert.equal(source.hits, 1);
  assert.equal(source.rows[0].resolved, undefined);
});

test('識別子のないWは別セッションに完了語があっても起票のまま', t => {
  const source = crossSessionFixture(t, {
    excerpt: 'CI の完了を待っています',
    completedText: '修正はマージ済みです。'
  });
  assert.equal(source.hits, 1);
  assert.equal(source.rows[0].resolved, undefined);
});
