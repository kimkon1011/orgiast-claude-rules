import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isDeployCommand,
  resolveTargetDir,
  findProjectRoot,
  detectKind,
  hasFeedback,
  exemptReason,
  judge,
  isRegistered,
} from './feedback-form-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, 'feedback-form-gate.mjs');

function makeFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-gate-'));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('Next.js で FeedbackWidget なし + vercel deploy --prod → deny', () => {
  const dir = makeFixture();
  try {
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' } }));
    const result = judge({ command: 'vercel deploy --prod', cwd: dir });
    assert.equal(result.deny, true);
    assert.match(result.reason, /\[FEEDBACK-FORM\]/);
  } finally {
    cleanup(dir);
  }
});

test('Next.js で FeedbackWidget あり → 通す', () => {
  const dir = makeFixture();
  try {
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' } }));
    writeFile(path.join(dir, 'app', 'layout.js'), "import FeedbackWidget from './FeedbackWidget';\n");
    const result = judge({ command: 'vercel deploy --prod', cwd: dir });
    assert.equal(result.deny, false);
  } finally {
    cleanup(dir);
  }
});

test('GAS で FeedbackRelay なし + clasp push → deny', () => {
  const dir = makeFixture();
  try {
    writeFile(path.join(dir, 'appsscript.json'), JSON.stringify({ timeZone: 'Asia/Tokyo' }));
    const result = judge({ command: 'clasp push', cwd: dir });
    assert.equal(result.deny, true);
    assert.match(result.reason, /\[FEEDBACK-FORM\]/);
  } finally {
    cleanup(dir);
  }
});

test('.feedback-exempt に理由 → 通す', () => {
  const dir = makeFixture();
  try {
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' } }));
    writeFile(path.join(dir, '.feedback-exempt'), '個人用ツール\n');
    const result = judge({ command: 'vercel deploy --prod', cwd: dir });
    assert.equal(result.deny, false);
  } finally {
    cleanup(dir);
  }
});

test('空の .feedback-exempt → deny', () => {
  const dir = makeFixture();
  try {
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' } }));
    writeFile(path.join(dir, '.feedback-exempt'), '   \n');
    const result = judge({ command: 'vercel deploy --prod', cwd: dir });
    assert.equal(result.deny, true);
  } finally {
    cleanup(dir);
  }
});

test('非デプロイ（npm test）→ 通す', () => {
  const dir = makeFixture();
  try {
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' } }));
    const result = judge({ command: 'npm test', cwd: dir });
    assert.equal(result.deny, false);
  } finally {
    cleanup(dir);
  }
});

test('cd "<fixture>" && node .../vc.js deploy --prod --yes を cwd=os.tmpdir() で → fixture を対象に deny', () => {
  const dir = makeFixture();
  try {
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' } }));
    const command = `cd "${dir}" && node C:/x/node_modules/vercel/dist/vc.js deploy --prod --yes`;
    const result = judge({ command, cwd: os.tmpdir() });
    assert.equal(result.deny, true);
    assert.match(result.reason, /\[FEEDBACK-FORM\]/);
  } finally {
    cleanup(dir);
  }
});

test('package.json に next が無いディレクトリ → 通す', () => {
  const dir = makeFixture();
  try {
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4.0.0' } }));
    const result = judge({ command: 'vercel deploy --prod', cwd: dir });
    assert.equal(result.deny, false);
  } finally {
    cleanup(dir);
  }
});

test('isDeployCommand: git push は false、vercel --prod は true', () => {
  assert.equal(isDeployCommand('git push'), false);
  assert.equal(isDeployCommand('vercel --prod'), true);
});

test('壊れた JSON を stdin に渡すと exit 0・出力なし（fail-open）', () => {
  const result = spawnSync(process.execPath, [hookPath], {
    input: '{ this is not json',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

function makeNextWithForm(appName) {
  const dir = makeFixture();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }));
  fs.mkdirSync(path.join(dir, 'app', 'api', 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'layout.js'), "import FeedbackWidget from '../components/FeedbackWidget';\n");
  fs.writeFileSync(path.join(dir, 'app', 'api', 'feedback', 'route.ts'), `const APP_NAME = "${appName}";\n`);
  return dir;
}

test('フォームはあるが台帳未登録 → deny、理由に feedback-apps.json', () => {
  const dir = makeNextWithForm('未登録アプリ');
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ '別アプリ': 'a/b' }));
  try {
    const result = judge({ command: 'vercel deploy --prod', cwd: dir }, { registryFile: registry, env: {} });
    assert.equal(result.deny, true);
    assert.match(result.reason, /feedback-apps\.json/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('台帳登録済み、または FEEDBACK_REPO_MAP にあれば通す', () => {
  const dir = makeNextWithForm('カフェ業務チェック');
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ 'カフェ業務チェック': 'nishiOrgiast/cafe-checklist-app' }));
  try {
    assert.equal(judge({ command: 'vercel deploy --prod', cwd: dir }, { registryFile: registry, env: {} }).deny, false);
    fs.writeFileSync(registry, '{}');
    assert.equal(judge({ command: 'vercel deploy --prod', cwd: dir }, { registryFile: registry, env: { FEEDBACK_REPO_MAP: 'x=a/b,カフェ業務チェック=nishiOrgiast/cafe-checklist-app' } }).deny, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('同梱の tools/feedback-apps.json にカフェアプリが登録されている', () => {
  assert.equal(isRegistered('カフェ業務チェック', new URL('./feedback-apps.json', import.meta.url), {}), true);
});

test('Git Bash の /d/... 形式の cd を Windows パスに読み替える', { skip: process.platform !== 'win32' }, () => {
  assert.equal(resolveTargetDir('cd /d/Claude/x && vercel deploy', 'C:/tmp').toLowerCase(), path.normalize('D:/Claude/x').toLowerCase());
});
