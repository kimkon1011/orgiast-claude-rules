import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(toolsDir, '..');
const script = path.join(toolsDir, 'booth-case-study-gen.mjs');
const data = path.join(repoDir, 'data', 'booth-projects.json');

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoDir, encoding: 'utf8' });
}

function tempOutput() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'booth-case-study-'));
}

test('reads sample JSON', () => {
  const projects = JSON.parse(fs.readFileSync(data, 'utf8'));
  const fields = ['projectId', 'title', 'client', 'industry', 'event', 'boothSize', 'period', 'services', 'description', 'highlights', 'results', 'imagePaths', 'projectUrl'];
  assert.ok(projects.length >= 3);
  for (const project of projects) for (const field of fields) assert.ok(field in project, `${project.projectId}: ${field}`);
});

test('dry-run produces output files', (t) => {
  const output = tempOutput();
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const result = run(['--data', data, '--output', output, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(output, 'C0056-case-study.md')));
  assert.ok(fs.existsSync(path.join(output, 'index.md')));
});

test('missing input exits non-zero', () => {
  const result = run(['--data', 'nonexistent.json', '--dry-run']);
  assert.notEqual(result.status, 0);
});

test('company-intro mode', (t) => {
  const output = tempOutput();
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const result = run(['--data', data, '--output', output, '--company-intro', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(output, 'company-intro.md')));
});

test('index generation', (t) => {
  const output = tempOutput();
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const result = run(['--data', data, '--output', output, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const index = fs.readFileSync(path.join(output, 'index.md'), 'utf8');
  assert.match(index, /\[産業DXを体感できる商談重視ブース（三共精機株式会社）\]\(\.\/C0056-case-study\.md\)/);
});

test('version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
