import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPlan } from './agent-integration-plan.mjs';

const REAL_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function createRepo(processes, domains = [{ key: 'test', label: 'テスト' }]) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-integration-plan-'));
  const catalogPath = path.join(repo, 'tools', 'agent-integration-catalog.json');
  const docPath = path.join(repo, 'docs', 'agent-integration-plan.md');
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, updatedAt: '2026-09-19', domains, processes }), 'utf8');
  return { repo, catalogPath, docPath };
}

function processOf(id, owner, domain = 'test') {
  return { id, domain, name: `工程 ${id}`, manualRemainder: `人手 ${id}`, owner, evidence: `根拠 ${id}` };
}

function invoke(paths, options = {}) {
  let out = '';
  let err = '';
  const code = runPlan({
    ...paths,
    ...options,
    stdout: { write: (value) => { out += value; } },
    stderr: { write: (value) => { err += value; } },
  });
  return { code, out, err };
}

test('実在する artifact を covered に数え、率を四捨五入する', (t) => {
  const paths = createRepo([
    processOf('a', { kind: 'artifact', path: 'tools/a.mjs' }),
    processOf('b', { kind: 'manual' }),
    processOf('c', { kind: 'manual' }),
  ]);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(paths.repo, 'tools', 'a.mjs'), '', 'utf8');
  const result = invoke(paths, { json: true });
  assert.equal(result.code, 0);
  const summary = JSON.parse(result.out);
  assert.equal(summary.domains[0].covered, 1);
  assert.equal(summary.domains[0].rate, 33);
});

test('doc が CRLF でも check は通る（core.autocrlf=true の PC 対策）', (t) => {
  const paths = createRepo([processOf('a', { kind: 'manual' })]);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  invoke(paths, { write: true });
  fs.writeFileSync(paths.docPath, fs.readFileSync(paths.docPath, 'utf8').replace(/\n/gu, '\r\n'), 'utf8');
  const result = invoke(paths, { check: true });
  assert.equal(result.code, 0, result.err);
});

test('存在しない artifact は check で drift になる', (t) => {
  const paths = createRepo([processOf('missing', { kind: 'artifact', path: 'tools/missing.mjs' })]);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  invoke(paths, { write: true });
  const result = invoke(paths, { check: true });
  assert.equal(result.code, 1);
  assert.match(result.err, /drift: missing -> tools\/missing\.mjs が存在しません/u);
});

test('external は covered ではなく unverified に数える', (t) => {
  const paths = createRepo([processOf('external', { kind: 'external', ref: 'example/repo' })]);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  const result = invoke(paths, { json: true });
  const summary = JSON.parse(result.out);
  assert.equal(summary.totals.covered, 0);
  assert.equal(summary.totals.unverified, 1);
  assert.equal(summary.totals.rate, 0);
});

test('manual は gap に数え、次に作るべき節へ id 順で出す', (t) => {
  const paths = createRepo([
    processOf('z-last', { kind: 'manual' }),
    processOf('a-first', { kind: 'manual' }),
  ]);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  const json = invoke(paths, { json: true });
  assert.deepEqual(JSON.parse(json.out).gaps, ['a-first', 'z-last']);
  const markdown = invoke(paths);
  assert.ok(markdown.out.indexOf('[test] 工程 a-first') < markdown.out.indexOf('[test] 工程 z-last'));
});

test('古い doc は check で失敗し、write 後は成功する', (t) => {
  const paths = createRepo([processOf('manual', { kind: 'manual' })]);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  fs.writeFileSync(paths.docPath, '古い\n', 'utf8');
  const stale = invoke(paths, { check: true });
  assert.equal(stale.code, 1);
  assert.match(stale.err, /docs\/agent-integration-plan\.md が古い/u);
  assert.equal(invoke(paths, { write: true }).code, 0);
  assert.equal(invoke(paths, { check: true }).code, 0);
});

test('unknown owner.kind はエラーになる', (t) => {
  const paths = createRepo([processOf('bad-kind', { kind: 'robot' })]);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  const result = invoke(paths, { check: true });
  assert.equal(result.code, 1);
  assert.match(result.err, /unknown owner\.kind/u);
});

test('id 重複はエラーになる', (t) => {
  const paths = createRepo([processOf('same', { kind: 'manual' }), processOf('same', { kind: 'manual' })]);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  const result = invoke(paths, { check: true });
  assert.equal(result.code, 1);
  assert.match(result.err, /id が重複/u);
});

test('domains に無い domain はエラーになる', (t) => {
  const paths = createRepo([processOf('orphan', { kind: 'manual' }, 'missing-domain')]);
  t.after(() => fs.rmSync(paths.repo, { recursive: true, force: true }));
  const result = invoke(paths, { check: true });
  assert.equal(result.code, 1);
  assert.match(result.err, /domains に無い domain/u);
});

test('実リポジトリのカタログと生成 doc に drift がない', () => {
  let err = '';
  const code = runPlan({ repo: REAL_REPO, check: true, stderr: { write: (value) => { err += value; } } });
  assert.equal(code, 0, err);
});
