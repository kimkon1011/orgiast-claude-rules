import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHostRepo, formatDetectMessage, knownProjectRoots } from './makimono-host-detect.mjs';

// 作った一時リポは必ず消す。api/v1/listings を持つディレクトリが残ると、
// docs/makimono-auto-approve.md §0 の「本体リポを持つPCか」判定 grep が偽陽性を出し、
// 本体リポの無いPCを当事者だと誤認させる(実測で298個溜まっていた)。
const temps = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'makimono-host-')); temps.push(dir); return dir; }
after(() => { for (const dir of temps) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } });
function makeRepo(root, prefix = 'repo') {
  const repo = path.join(root, prefix);
  fs.mkdirSync(path.join(repo, 'app', 'api', 'v1', 'listings'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'app', 'api', 'v1', 'listings', 'route.ts'), 'export {}');
  fs.writeFileSync(path.join(repo, 'package.json'), '{}');
  return repo;
}

test('listings route から本体リポを検出する', () => {
  const root = temp(); const repo = makeRepo(root);
  assert.deepEqual(detectHostRepo({ roots: [root], budgetMs: 1000, now: Date.now() }).status, 'found');
  assert.equal(detectHostRepo({ roots: [root], budgetMs: 1000, now: Date.now() }).repoPath, repo);
});

test('node_modules 配下は無視する', () => {
  const root = temp(); makeRepo(root, 'node_modules/repo');
  assert.equal(detectHostRepo({ roots: [root], budgetMs: 1000, now: Date.now() }).status, 'absent');
});

test('空のルートは absent', () => {
  assert.equal(detectHostRepo({ roots: [temp()], budgetMs: 1000, now: Date.now() }).status, 'absent');
});

test('時間予算 0 は unknown', () => {
  assert.equal(detectHostRepo({ roots: [temp()], budgetMs: 0, now: Date.now() }).status, 'unknown');
});

test('absent と unknown のメッセージは空', () => {
  assert.equal(formatDetectMessage({ status: 'absent' }), '');
  assert.equal(formatDetectMessage({ status: 'unknown' }), '');
});

test('予算切れまでに完了したルートを保存し、次回は未走査から始める', () => {
  const first = temp(); const second = temp();
  let tick = 0; const visited = [];
  const state1 = detectHostRepo({ roots: [first, second], budgetMs: 5, rootBudgetMs: 100, clock: () => tick++, onRootStart: (root) => visited.push(root) });
  assert.equal(state1.status, 'unknown');
  assert.deepEqual(state1.scannedRoots, [first]);
  assert.deepEqual(state1.pendingRoots, [second]);
  tick = 0; visited.length = 0;
  const state2 = detectHostRepo({ roots: [first, second], previousState: state1, budgetMs: 100, rootBudgetMs: 100, clock: () => tick++, onRootStart: (root) => visited.push(root) });
  assert.deepEqual(visited, [second]);
  assert.equal(state2.status, 'absent');
});

test('全ルート完了なら absent、giveUpRoots があれば unknown', () => {
  const root = temp();
  assert.equal(detectHostRepo({ roots: [root], budgetMs: 1000 }).status, 'absent');
  const state = detectHostRepo({ roots: [root], previousState: { giveUpRoots: [root] }, budgetMs: 1000 });
  assert.equal(state.status, 'unknown');
});

test('.claude.json の projects が探索先の先頭に来る', () => {
  const home = temp(); const project = temp(); const generic = temp();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [project]: {} } }));
  const priorityRoots = knownProjectRoots(home);
  assert.equal(priorityRoots[0], project);
  const visited = [];
  detectHostRepo({ roots: [generic], priorityRoots, budgetMs: 1000, onRootStart: (root) => visited.push(root) });
  assert.deepEqual(visited, [project, generic]);
});

test('project jsonl の先頭から cwd を拾い、壊れた jsonl は無視する', () => {
  const home = temp(); const project = temp();
  const slug = path.join(home, '.claude', 'projects', 'c--Users-test');
  fs.mkdirSync(slug, { recursive: true });
  fs.writeFileSync(path.join(slug, 'broken.jsonl'), '{broken');
  fs.writeFileSync(path.join(slug, 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: project })}\n`);
  assert.deepEqual(knownProjectRoots(home), [project]);
});

test('同一ルートが3回連続で打ち切られたら giveUpRoots に入る', () => {
  const root = temp(); fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  let previousState;
  for (let attempt = 0; attempt < 3; attempt++) {
    let tick = 0;
    previousState = detectHostRepo({ roots: [root], previousState, budgetMs: 100, rootBudgetMs: 2, clock: () => tick++ });
  }
  assert.deepEqual(previousState.giveUpRoots, [root]);
  assert.equal(previousState.status, 'unknown');
});
