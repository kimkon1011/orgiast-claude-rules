import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectInteractionAdoption } from './interaction-adoption.mjs';
import { gitBlobSha } from './version-drift.mjs';

function fixture({ missing = false, metrics = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-adoption-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tools', 'interaction-loop.mjs'), 'loop\n');
  if (!missing) fs.writeFileSync(path.join(repo, 'tools', 'stop-gate.mjs'), 'stop\n');
  if (metrics) fs.writeFileSync(path.join(home, '.claude', 'interaction-metrics.json'), JSON.stringify({ history: [{ generatedAt: '2026-08-30T18:00:00Z' }] }));
  return { repo, home };
}

function tree(repo, loop = null) {
  const sha = (name) => gitBlobSha(fs.readFileSync(path.join(repo, 'tools', name)));
  return { tree: [
    { path: 'tools/interaction-loop.mjs', sha: loop || sha('interaction-loop.mjs') },
    { path: 'tools/stop-gate.mjs', sha: sha('stop-gate.mjs') },
  ] };
}

const passingTests = async () => ({ code: 0, stdout: 'ℹ tests 2\n' });

test('SHA一致は適用済とJSTの最終実行を返す', async () => {
  const files = fixture({ metrics: true });
  const result = await collectInteractionAdoption({ ...files, fetchTree: async () => tree(files.repo), runTest: passingTests });
  const local = gitBlobSha(fs.readFileSync(path.join(files.repo, 'tools', 'interaction-loop.mjs'))).slice(0, 7);
  assert.equal(result.version, `適用済(${local})`);
  assert.equal(result.lastRun, '2026-08-31 03:00');
  assert.equal(result.selftest, 'PASS 4/4');
});

test('SHA不一致はローカルとmainのSHAを返す', async () => {
  const files = fixture();
  const mainSha = gitBlobSha('new loop\n');
  const result = await collectInteractionAdoption({ ...files, fetchTree: async () => tree(files.repo, mainSha), runTest: passingTests });
  const local = gitBlobSha('loop\n').slice(0, 7);
  assert.equal(result.version, `旧版(${local} / main=${mainSha.slice(0, 7)})`);
});

test('ファイル欠落は未適用', async () => {
  const files = fixture({ missing: true });
  const result = await collectInteractionAdoption({ ...files, fetchTree: async () => { throw new Error('should not fetch'); }, runTest: passingTests });
  assert.equal(result.version, '未適用');
});

test('tree取得失敗は判定不能', async () => {
  const files = fixture();
  const result = await collectInteractionAdoption({ ...files, fetchTree: async () => { throw new Error('offline'); }, runTest: passingTests });
  assert.equal(result.version, '判定不能');
});

test('metricsが無ければ最終実行は未実行', async () => {
  const files = fixture();
  const result = await collectInteractionAdoption({ ...files, fetchTree: async () => tree(files.repo), runTest: passingTests });
  assert.equal(result.lastRun, '未実行');
});
