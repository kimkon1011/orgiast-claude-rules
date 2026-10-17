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
  fs.writeFileSync(path.join(dir, 'app', 'layout.js'), 'export default function Layout() { return <FeedbackWidget />; }\n');
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

for (const command of ['clasp deployments', 'clasp list-deployments', 'npx clasp deployments', 'vercel deployments', 'node x/vc.js deployments', 'netlify deployments', 'wrangler deployments list', 'wrangler pages deployments list', 'firebase deployments', 'npm run deployment-status', 'clasp pushes']) {
  test(`読取・別サブコマンドを止めない: ${command}`, () => assert.equal(isDeployCommand(command), false));
}
for (const command of ['clasp deploy', 'npx clasp deploy --description test', 'clasp push --force', 'vercel deploy --prod', 'vercel redeploy x', 'node x/vc.js redeploy x', 'netlify deploy', 'wrangler deploy', 'wrangler pages deploy dist', 'firebase deploy --only hosting', 'npm run deploy:prod', 'node gas/deploy.mjs']) {
  test(`本番反映の検査を維持: ${command}`, () => assert.equal(isDeployCommand(command), true));
}

const fakeSharedUrl = 'https://script.google.com/macros/s/TEST_ONLY_NOT_A_DEPLOYMENT/exec';
for (const [name, source, expected] of [
  ['HTML', `<a href="${fakeSharedUrl}?form=feedback&amp;app=test">報告</a>`, true],
  ['JS', `const link = '${fakeSharedUrl}?app=test&form=feedback';`, true],
  ['GS', `const link = '${fakeSharedUrl}?form=feedback&app=test';`, true],
  ['方式A', 'FeedbackRelay_render()', true],
  ['別フォーム', `<a href="${fakeSharedUrl}?form=other">報告</a>`, false],
  ['似た値', `<a href="${fakeSharedUrl}?form=feedback-other">報告</a>`, false],
  ['分離した文字列', `const link = '${fakeSharedUrl}'; const mode = 'form=feedback';`, false],
  ['別ホスト', '<a href="https://example.invalid/exec?form=feedback">報告</a>', false],
]) {
  test(`GAS 方式B ${name}: rootDir 内を判定`, () => {
    const dir = makeFixture();
    try {
      writeFile(path.join(dir, '.clasp.json'), JSON.stringify({ rootDir: 'src' }));
      writeFile(path.join(dir, 'outside.html'), `<a href="${fakeSharedUrl}?form=feedback">外側</a>`);
      writeFile(path.join(dir, 'src', `Code.${name === 'JS' ? 'js' : name === 'GS' ? 'gs' : 'html'}`), source);
      assert.equal(hasFeedback(dir, 'gas'), expected);
      assert.equal(judge({ command: 'clasp push', cwd: dir }, { env: {}, home: dir }).deny, !expected);
    } finally { cleanup(dir); }
  });
}

test('GAS 拒否に env ファイルから完成済み方式Bリンクを表示し、そのリンクで通過する', () => {
  const home = makeFixture();
  const dir = path.join(home, '日本語 & アプリ (検証)');
  try {
    writeFile(path.join(dir, 'appsscript.json'), '{}');
    writeFile(path.join(home, '.claude', 'feedback-relay.env'), `\uFEFF# private\nFEEDBACK_SHARED_FORM_URL="${fakeSharedUrl}"\nPRIVATE_OTHER=DO_NOT_PRINT\n`);
    const result = judge({ command: 'clasp push', cwd: dir }, { env: {}, home });
    assert.equal(result.deny, true);
    const expected = `<a href="${fakeSharedUrl}?form=feedback&amp;app=${encodeURIComponent(path.basename(dir))}" target="_blank" rel="noopener">不具合・要望</a>`;
    assert.ok(result.reason.includes(expected));
    assert.ok(!result.reason.includes('DO_NOT_PRINT'));
    assert.ok(!result.reason.includes('node verify.mjs'));
    writeFile(path.join(dir, 'Index.html'), expected);
    assert.equal(judge({ command: 'clasp push', cwd: dir }, { env: {}, home }).deny, false);
  } finally { cleanup(home); }
});

test('GAS URL 未取得・不正なら自分の配布済みツールへの取得コマンドを表示する', () => {
  const dir = makeFixture();
  try {
    writeFile(path.join(dir, 'appsscript.json'), '{}');
    for (const value of ['', 'https://example.invalid/exec', 'javascript:alert(1)', 'https://script.google.com.evil.invalid/macros/s/test/exec']) {
      const result = judge({ command: 'clasp deploy', cwd: dir }, { env: { FEEDBACK_SHARED_FORM_URL: value }, home: dir });
      assert.equal(result.deny, true);
      assert.ok(result.reason.includes(`node "${path.join(here, 'onboarding-sync.mjs')}" --keys-only --force`));
      assert.ok(!result.reason.includes('kim に確認'));
      assert.ok(!result.reason.includes('<a href='));
    }
  } finally { cleanup(dir); }
});

test('GAS hook process は ORGIAST_HOME の env を読み PowerShell にリンクを返す', () => {
  const home = makeFixture();
  try {
    writeFile(path.join(home, 'appsscript.json'), '{}');
    writeFile(path.join(home, '.claude', 'feedback-relay.env'), `FEEDBACK_SHARED_FORM_URL=${fakeSharedUrl}\n`);
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_name: 'PowerShell', cwd: home, tool_input: { command: 'clasp push' } }),
      encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, FEEDBACK_SHARED_FORM_URL: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny');
    assert.ok(output.permissionDecisionReason.includes(fakeSharedUrl));
  } finally { cleanup(home); }
});
