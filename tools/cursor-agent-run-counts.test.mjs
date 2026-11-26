import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCursorAgentRunCounts, cursorAgentRunsTxtPath } from './cursor-agent-run-counts.mjs';

test('朝の件数集計は今日と周期開始以降を1行に書く', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-runs-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'executor-usage.jsonl'), [
    JSON.stringify({ t: '2026-11-20T15:00:00+09:00', provider: 'fallback', model: 'cursor-agent/cursor-agent', status: 'ok' }),
    JSON.stringify({ t: '2026-11-21T10:00:00+09:00', provider: 'fallback', model: 'cursor-agent/cursor-agent', status: 'ok' }),
    JSON.stringify({ t: '2026-11-21T11:00:00+09:00', provider: 'fallback', model: 'cursor-agent/cursor-agent', status: 'timeout' }),
  ].join('\n') + '\n');
  const now = Date.parse('2026-11-21T12:00:00+09:00');
  const result = runCursorAgentRunCounts({ home, now, host: '000KIMPC' });
  assert.equal(result.today.ok, 1);
  assert.equal(result.today.timeout, 1);
  assert.equal(result.sinceReset.ok, 2);
  assert.match(fs.readFileSync(cursorAgentRunsTxtPath(home), 'utf8'), /host=000KIMPC 今日 cursor-agent 試行2 成功1/);
});
