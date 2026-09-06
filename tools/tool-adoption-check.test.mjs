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

function runLedger({ rows, deadline = '5000', countReads = false }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-adoption-ledger-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
    const countFile = path.join(home, 'ledger-read-count.txt');
    const stdout = execFileSync(process.execPath, [script, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORGIAST_HOME: home,
        TOOL_ADOPTION_FORCE_TIMEOUT: 'codex,gemini',
        TOOL_ADOPTION_FORCE_PRESENT: 'codex,gemini',
        TOOL_ADOPTION_DEADLINE_MS: deadline,
        ...(countReads ? { TOOL_ADOPTION_LEDGER_READ_COUNT_FILE: countFile } : {}),
      },
    });
    return { stdout, readCount: fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0 };
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

test('十分な予算では直近7日のprovider別件数を正しく集計する', () => {
  const recent = new Date().toISOString();
  const old = '2020-01-01T00:00:00.000Z';
  const { stdout } = runLedger({ rows: [
    { t: recent, provider: 'groq' },
    { t: recent, provider: 'groq' },
    { t: recent, provider: 'kimi' },
    { t: old, provider: 'groq' },
  ] });
  assert.match(stdout, /groq 2 \/ kimi 1/);
  assert.match(stdout, /\| groq \| 2 \| ✅ \|/);
  assert.match(stdout, /\| kimi \| 1 \| ✅ \|/);
});

test('台帳読み取りが時間切れなら使用0とせず計測不能にする', () => {
  const { stdout } = runLedger({ rows: [{ t: new Date().toISOString(), provider: 'groq' }], deadline: '0' });
  assert.match(stdout, /計測不能\(台帳の読み取りが時間切れ・次回再判定\)/);
  assert.match(stdout, /\| groq \| — \| ❓ 計測不能\(次回再判定\) \|/);
  assert.doesNotMatch(stdout, /\| (?:kimi|groq|openrouter|gemini|deepseek) \| [^\n]*使用0/);
});

test('同一プロセスの複数集計でも台帳ファイルは1回だけ読む', () => {
  const { readCount } = runLedger({ rows: [{ t: new Date().toISOString(), provider: 'kimi' }], countReads: true });
  assert.equal(readCount, 1);
});
