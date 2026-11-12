import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_PATH = path.join(__dirname, 'illustrator-mcp.mjs');

function runMcp(args = []) {
  return spawnSync(process.execPath, [MCP_PATH, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
}

describe('illustrator-mcp', () => {
  it('--info returns valid JSON', () => {
    const r = runMcp(['--info']);
    assert.equal(r.status, 0);
    const info = JSON.parse(r.stdout);
    assert.equal(info.name, 'illustrator-mcp');
    assert.equal(info.version, '1.0.0');
    assert.ok(Array.isArray(info.tools));
    assert.ok(info.tools.includes('generate_extendscript'));
    assert.ok(info.tools.includes('execute_script'));
    assert.ok(info.tools.includes('create_text_effect'));
    assert.ok(info.tools.includes('export_artboard'));
  });

  it('responds to MCP initialize', () => {
    const r = spawnSync(process.execPath, [MCP_PATH], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n',
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 1);
    assert.equal(parsed.result.protocolVersion, '2024-11-05');
    assert.ok(parsed.result.capabilities.tools);
    assert.equal(parsed.result.serverInfo.name, 'illustrator-mcp');
  });

  it('tools/list returns tool definitions', () => {
    const r = spawnSync(process.execPath, [MCP_PATH], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.ok(Array.isArray(parsed.result.tools));
    const names = parsed.result.tools.map(t => t.name);
    assert.ok(names.includes('generate_extendscript'));
    assert.ok(names.includes('create_text_effect'));
  });

  it('generate_extendscript produces valid ExtendScript', () => {
    const r = spawnSync(process.execPath, [MCP_PATH], {
      input: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'generate_extendscript', arguments: { description: 'ブースサイン用の見出しテキストを作成' } },
      }) + '\n',
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    const code = parsed.result.content[0].text;
    // Should contain ExtendScript constructs
    assert.ok(code.includes('app.'));
    assert.ok(code.includes('documents') || code.includes('activeDocument'));
    assert.ok(parsed.result.script_path);
  });

  it('create_text_effect with misregistration produces valid script', () => {
    const r = spawnSync(process.execPath, [MCP_PATH], {
      input: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'create_text_effect', arguments: { text: 'TEST', effect: 'misregistration' } },
      }) + '\n',
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    const code = parsed.result.content[0].text;
    assert.ok(code.includes('app.'));
    assert.ok(parsed.result.script_path);
  });

  it('returns error for unknown tool', () => {
    const r = spawnSync(process.execPath, [MCP_PATH], {
      input: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      }) + '\n',
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.ok(parsed.error);
    assert.equal(parsed.error.code, -32601);
  });

  it('execute_script returns not_found when Illustrator missing', () => {
    const r = spawnSync(process.execPath, [MCP_PATH], {
      input: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'execute_script', arguments: { script_path: import.meta.url.replace('file:///', '').replace(/^\/([A-Za-z]:)/, '$1') } },
      }) + '\n',
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    const content = JSON.parse(parsed.result.content[0].text);
    assert.ok(content.reason === 'illustrator_not_found' || content.ok === false);
  });
});
