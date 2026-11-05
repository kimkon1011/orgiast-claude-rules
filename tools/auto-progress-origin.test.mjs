import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { originLine } from './auto-progress-ledger.mjs';

test('originLine skips synthetic user messages and falls back to label', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-origin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'session.jsonl');
  const messages = ['<task-notification>task-id', '<system-reminder>notice', '<command-name>/run</command-name>'];
  const save = values => fs.writeFileSync(transcriptPath, values.map(content => JSON.stringify({ type: 'user', message: { role: 'user', content } })).join('\n'));
  const row = { sessionId: 'test', purpose: messages[0], transcriptPath, label: '台帳の作業名' };
  save([...messages, [{ type: 'text', text: '通知に操作手順を表示してください' }]]);
  assert.match(originLine(row), /セッションの目的: 通知に操作手順を表示してください/);
  save(messages);
  assert.match(originLine(row), /セッションの目的: 台帳の作業名/);
  assert.doesNotMatch(originLine(row), /<task-|<system-|<command-/);
  assert.match(originLine({ ...row, purpose: '' }), /セッションの目的: 台帳の作業名/);
});
