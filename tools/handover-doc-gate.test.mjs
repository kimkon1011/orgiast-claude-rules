import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeployCommand, findProjectRoot, hasHandover, judge, selftest } from './handover-doc-gate.mjs';

const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'handover-doc-gate.mjs');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-test-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('対象コマンドの判定', () => {
  for (const c of ['wrangler deploy', 'npx wrangler pages deploy dist', 'vercel deploy --prod', 'vercel --prod', 'clasp push', 'npm run deploy']) assert.equal(isDeployCommand(c), true, c);
  for (const c of ['npm run build', 'git push', 'wrangler dev', '']) assert.equal(isDeployCommand(c), false, c);
});

test('HANDOVER.md なし → deny、理由にひな形の場所を含む', () => {
  const dir = fixture({ 'package.json': '{}' });
  try {
    const r = judge({ command: 'npm run deploy', cwd: dir }, { env: {} });
    assert.equal(r.deny, true);
    assert.match(r.reason, /HANDOVER\.md を置く（ひな形: rules-extracted\/project-launch-playbook\.md §1\.12\.1[。）]/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HANDOVER.md あり → 通す / サブディレクトリからでも親を辿る', () => {
  const dir = fixture({ 'wrangler.jsonc': '{}', 'HANDOVER.md': '# x', 'src/a.txt': '' });
  try {
    assert.equal(findProjectRoot(path.join(dir, 'src')), dir);
    assert.equal(hasHandover(dir), true);
    assert.equal(judge({ command: 'wrangler deploy', cwd: path.join(dir, 'src') }, { env: {} }).deny, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--cwd 指定を優先する', () => {
  const noDoc = fixture({ '.clasp.json': '{}' });
  const withDoc = fixture({ 'package.json': '{}', 'HANDOVER.md': '# x' });
  try {
    assert.equal(judge({ command: `clasp push --cwd "${noDoc}"`, cwd: withDoc }, { env: {} }).deny, true);
  } finally { fs.rmSync(noDoc, { recursive: true, force: true }); fs.rmSync(withDoc, { recursive: true, force: true }); }
});

test('HANDOVER_GATE_SKIP=1 で素通し', () => {
  const dir = fixture({ 'package.json': '{}' });
  try {
    assert.equal(judge({ command: 'npm run deploy', cwd: dir }, { env: { HANDOVER_GATE_SKIP: '1' } }).deny, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('selftest が通る', () => {
  assert.deepEqual(selftest(), []);
});

test('hook: stdin の JSON で deny を返し、壊れた入力は fail-open', () => {
  const dir = fixture({ 'package.json': '{}' });
  try {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm run deploy' }, cwd: dir });
    const out = spawnSync(process.execPath, [hookPath], { input: payload, encoding: 'utf8', env: { ...process.env, HANDOVER_GATE_SKIP: '' } });
    assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const bad = spawnSync(process.execPath, [hookPath], { input: '{not json', encoding: 'utf8' });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout.trim(), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
