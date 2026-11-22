import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCursorUsagePace } from './cursor-usage-pace.mjs';
import { cursorUsagePaceTxtPath } from './lib/cursor-usage-pace.mjs';

test('CLI は引数の％で1行を書き、遅れなら fill する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-cli-'));
  const now = Date.parse('2026-11-21T23:17:00+09:00');
  const result = await runCursorUsagePace({
    home,
    now,
    args: ['--cursor-models', '5', '--other-models', '1', '--source', 'owner-report'],
  });
  assert.equal(result.decision, 'behind');
  assert.equal(result.fill, true);
  assert.equal(fs.readFileSync(cursorUsagePaceTxtPath(home), 'utf8').trim(), result.line);
  assert.match(result.line, /取得:owner-report/);
});

test('公式APIが取れないときは％なしで unknown と書き、引数が無いと推測しない', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-cli-missing-'));
  const now = Date.parse('2026-11-21T23:17:00+09:00');
  const result = await runCursorUsagePace({
    home,
    now,
    fetchPlanImpl: async () => ({ ok: false, source: 'unavailable' }),
  });
  assert.equal(result.decision, 'unknown');
  assert.equal(result.fill, false);
  assert.match(result.line, /Cursor Models —%/);
  assert.match(fs.readFileSync(cursorUsagePaceTxtPath(home), 'utf8'), /判定:未取得/);
});
