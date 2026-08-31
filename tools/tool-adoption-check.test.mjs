import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const script = path.resolve('tools', 'tool-adoption-check.mjs');

function runFix(initial) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-adoption-gemini-'));
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', '.env'), 'GEMINI_API_KEY=test-key\n');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'gemini-cli': initial } }, null, 2));
  execFileSync(process.execPath, [script, '--dry-run', '--fix'], {
    env: {
      ...process.env,
      ORGIAST_HOME: home,
      TOOL_ADOPTION_FORCE_PRESENT: 'codex,gemini',
      TOOL_ADOPTION_DEADLINE_MS: '0',
    },
    stdio: 'ignore',
  });
  const result = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers['gemini-cli'];
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

function runAuthFix({ settingsText, withKey = true }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-adoption-gemini-auth-'));
  try {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    if (settingsText !== undefined) fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), settingsText);
    if (withKey) fs.writeFileSync(path.join(home, '.gemini', '.env'), 'GEMINI_API_KEY=test-key\n');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }, null, 2));
    const stdout = execFileSync(process.execPath, [script, '--dry-run', '--fix'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GEMINI_API_KEY: '',
        ORGIAST_HOME: home,
        TOOL_ADOPTION_FORCE_PRESENT: 'codex,gemini',
        TOOL_ADOPTION_DEADLINE_MS: '0',
      },
    });
    const settingsPath = path.join(home, '.gemini', 'settings.json');
    return {
      stdout,
      text: fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : undefined,
      backupExists: fs.existsSync(settingsPath + '.bak.adoption-' + new Date().toISOString().slice(0, 10)),
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('@choplin の旧Gemini MCP設定を gemini-mcp-tool へ修復する', () => {
  const result = runFix({ type: 'stdio', command: 'npx', args: ['-y', '@choplin/mcp-gemini-cli', '--allow-npx'], env: { GEMINI_API_KEY: 'test-key' } });
  assert.deepEqual(result, { type: 'stdio', command: 'npx', args: ['-y', 'gemini-mcp-tool'], env: { GEMINI_API_KEY: 'test-key', GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_MCP_BACKEND: 'gemini' } });
});

test('node絶対パス形式の互換Gemini MCP設定を上書きしない', () => {
  const initial = { type: 'stdio', command: 'node', args: ['C:/npm/node_modules/gemini-mcp-tool/dist/index.js'], env: { GEMINI_API_KEY: 'test-key', GEMINI_MCP_BACKEND: 'gemini', CUSTOM: 'keep' } };
  assert.deepEqual(runFix(initial), initial);
});

test('既定のnpx形式の互換Gemini MCP設定を上書きしない', () => {
  const initial = { type: 'stdio', command: 'npx', args: ['-y', 'gemini-mcp-tool'], env: { GEMINI_API_KEY: 'test-key', GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_MCP_BACKEND: 'gemini' } };
  assert.deepEqual(runFix(initial), initial);
});

test('旧Gemini認証設定を新スキーマへ移行し旧キーを削除する', () => {
  const result = runAuthFix({ settingsText: JSON.stringify({ selectedAuthType: 'oauth-personal', theme: 'keep' }) });
  assert.deepEqual(JSON.parse(result.text), { theme: 'keep', security: { auth: { selectedType: 'gemini-api-key' } } });
  assert.equal(result.backupExists, true);
  assert.match(result.stdout, /gemini の認証方式を新スキーマ/);
});

test('新スキーマのGemini認証設定は書き換えない', () => {
  const original = JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } });
  const result = runAuthFix({ settingsText: original });
  assert.equal(result.text, original);
  assert.equal(result.backupExists, false);
  assert.doesNotMatch(result.stdout, /gemini の認証方式を新スキーマ/);
});

test('Gemini APIキーが無い場合は設定を書き換えず人手案内する', () => {
  const original = JSON.stringify({ selectedAuthType: 'oauth-personal' });
  const result = runAuthFix({ settingsText: original, withKey: false });
  assert.equal(result.text, original);
  assert.equal(result.backupExists, false);
  assert.match(result.stdout, /AI Studio|aistudio\.google\.com\/apikey/);
});

test('壊れたGemini settings JSONは例外を投げず書き換えない', () => {
  const original = '{ broken';
  const result = runAuthFix({ settingsText: original });
  assert.equal(result.text, original);
  assert.equal(result.backupExists, false);
  assert.doesNotMatch(result.stdout, /gemini の認証方式を新スキーマ/);
});
