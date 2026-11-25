import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionProgressCheck } from './session-progress-check.mjs';
import { SESSION_PHRASES } from './next-action-gate.mjs';
const footer = state => `次に kim がすること: なし\nこの後の自動進行: なし\nこのセッション: ${state}`;
const assistant = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
for (const [name, entries, expected] of [
  ['closed', [assistant(footer(SESSION_PHRASES.closed))], 0],
  ['不要', [assistant(footer(SESSION_PHRASES.delete))], 0],
  ['まだ閉じない', [assistant(footer('まだ閉じない（作業中・2000-01-01 00:00 まで待つ）'))], 1],
  ['最新が未完了', [assistant(footer(SESSION_PHRASES.closed)), assistant('継続中です')], 1],
  ['sidechainを除外', [assistant('継続中です'), { ...assistant(footer(SESSION_PHRASES.closed)), isSidechain: true }], 1],
  ['tool_useを最終応答に数えない', [{ type: 'assistant', message: { content: [{ type: 'text', text: footer(SESSION_PHRASES.closed) }, { type: 'tool_use', name: 'Bash' }] } }], 1],
  ['transcriptなし', null, 1],
]) for (const eol of ['\n', '\r\n']) test(`session-progress-check: ${name} (${eol === '\n' ? 'LF' : 'CRLF'})`, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-progress-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (entries) {
    const dir = path.join(home, '.claude/projects/nested/project');
    fs.mkdirSync(dir, { recursive: true });
    const records = entries.map(entry => JSON.stringify(entry, (key, value) =>
      typeof value === 'string' ? value.replace(/\r?\n/g, eol) : value));
    fs.writeFileSync(path.join(dir, 'test-session.jsonl'), records.join(eol) + eol);
  }
  assert.equal(sessionProgressCheck('test-session', { home }), expected);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./session-progress-check.mjs', import.meta.url)), '--session', 'test-session'], { env: { ...process.env, ORGIAST_HOME: home }, encoding: 'utf8' });
  assert.ifError(cli.error);
  assert.equal(cli.stderr, '', 'CLI must start successfully, including for incomplete sessions');
  assert.equal(cli.status, expected, cli.stderr);
});
