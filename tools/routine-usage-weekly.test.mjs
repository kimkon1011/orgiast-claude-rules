import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
import { aggregateRoutineUsage, markdown, writeRoutineUsage } from './routine-usage-weekly.mjs';

test('PC×job別に7日利用と無変化率を集計する', () => {
  const now = Date.parse('2026-11-25T00:00:00Z');
  const data = aggregateRoutineUsage({ now, host: 'pc1', usageRows: [{ t: '2026-11-24T00:00:00Z', job: 'watch', in: 10, out: 2, usd: .1 }], runRows: [{ t: '2026-11-24T00:00:00Z', host: 'pc1', job: 'watch', changed: false }] });
  assert.equal(data[0].llmCalls, 1); assert.equal(data[0].noChangeRate, 1); assert.match(markdown(data), /watch/);
});

test('Markdownを所定ファイルへ書く', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-usage-')); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const result = await writeRoutineUsage({ home, includeFleet: false });
  assert.equal(fs.existsSync(result.file), true);
});
