import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptMetricCache } from './transcript-metric-cache.mjs';
import { collectUserReworkStats } from './user-rework-stats.mjs';
import { collectUserBurdenMetrics } from './user-burden-metrics.mjs';

const row = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-cache-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'one.jsonl');
  fs.writeFileSync(file, [row('依頼'), row('何回も')].join('\n'));
  return { home, file, dir };
}

for (const collect of [collectUserReworkStats, collectUserBurdenMetrics]) {
  test(`${collect.name}: 永続cache再利用、追記・同サイズ変更・削除・期限切れを反映`, t => {
    const { home, file, dir } = fixture(t);
    const opts = { home, transcriptPath: file };
    const originalRead = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, 'readFileSync', function(p, ...args) {
      if (String(p).endsWith('.jsonl')) reads++;
      return originalRead.call(this, p, ...args);
    });
    const first = collect(opts);
    assert.ok(reads > 0);
    reads = 0;
    assert.deepEqual(collect(opts), first);
    assert.equal(reads, 0, 'unchanged transcripts are not read on the next collection');
    fs.appendFileSync(file, '\n' + row('同じこと'));
    const appended = collect(opts);
    assert.notDeepEqual(appended, first);
    assert.ok(reads > 0);
    const before = fs.statSync(file);
    fs.writeFileSync(file, originalRead(file, 'utf8').replace('何回も', 'お願い'));
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
    assert.notDeepEqual(collect(opts), appended);
    const second = path.join(dir, 'two.jsonl');
    fs.writeFileSync(second, row('何回も'));
    assert.ok(collect({ home }).sevenDayCount > 0 || collect({ home }).sessions > 0);
    fs.unlinkSync(second);
    // Advancing the clock ages a cached transcript out without changing it.
    t.mock.method(Date, 'now', () => before.mtimeMs + 9 * 86400000);
    const expired = collect({ home });
    assert.equal(expired.sevenDayCount ?? expired.sessions, 0);
    fs.unlinkSync(file);
    assert.equal(collect({ home }).sevenDayCount ?? collect({ home }).sessions, 0);
  });
}

test('cache破損と保存不能でも再計算でき、読取中に変化したファイルは再利用しない', t => {
  const { home, file } = fixture(t);
  const cacheFile = path.join(home, '.claude', 'test-cache.json');
  fs.writeFileSync(cacheFile, '{bad json');
  const cache = transcriptMetricCache({ home, name: 'test' });
  assert.equal(cache.read(file, raw => { fs.appendFileSync(file, '\n' + row('追記')); return raw.length; }) > 0, true);
  cache.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile)).files, {});
  const cannotSave = transcriptMetricCache({ home, name: 'test', cacheDir: file });
  assert.ok(cannotSave.read(file, raw => raw.length) > 0);
  assert.doesNotThrow(() => cannotSave.save());
});
