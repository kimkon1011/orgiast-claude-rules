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
