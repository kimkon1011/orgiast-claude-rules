import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDailyNotices } from './daily-notices.mjs';

function fixture(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-notices-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const messages = [];
  return { home, now: new Date('2026-09-17T01:00:00Z'), messages,
    readNews: () => 'ニュース' + '📰'.repeat(2200), readTasks: async () => 'Googleタスク: 操作・判断待ち',
    notify: async (text, options) => { assert.equal(options.webhookFallback, false); messages.push(text); return { delivered: 'dm' }; },
    ...overrides,
  };
}
test('両出力を欠落なくDiscord上限内に分割し、同日は1回・翌日は再送', async t => {
  const f = fixture(t);
  assert.match((await runDailyNotices(f)).message, /^ok:/);
  const expected = `日次通知 (2026-09-17)\n\n${f.readNews()}\n\n${await f.readTasks()}`;
  assert.equal(f.messages.join(''), expected);
  assert(f.messages.every(m => m.length <= 1800 && !/[\uD800-\uDBFF]$/.test(m)));
  const count = f.messages.length;
  assert.match((await runDailyNotices(f)).message, /送信済み/);
  assert.equal(f.messages.length, count);
  await runDailyNotices({ ...f, now: new Date('2026-09-18T01:00:00Z') });
  assert.equal(f.messages.length, count * 2);
});
test('送信失敗は成功扱いにせず、次回は未送信の続きから', async t => {
  const f = fixture(t);
  let calls = 0;
  const notify = async (...args) => ++calls === 2 ? { delivered: 'none' } : f.notify(...args);
  await assert.rejects(runDailyNotices({ ...f, notify }), /DM送信に失敗/);
  const first = f.messages[0];
  await runDailyNotices(f);
  assert.equal(f.messages.filter(m => m === first).length, 1);
  assert.match(f.messages.at(-1), /Googleタスク/);
});
test('dry-run・空入力・並行起動は投稿しない', async t => {
  const f = fixture(t);
  assert.equal((await runDailyNotices({ ...f, dryRun: true })).dryRun, true);
  assert.match((await runDailyNotices({ ...f, readNews: () => '', readTasks: async () => '' })).message, /通知なし/);
  assert.equal(f.messages.length, 0);
  let unblock;
  const first = runDailyNotices({ ...f, readTasks: () => new Promise(resolve => { unblock = resolve; }) });
  assert.match((await runDailyNotices(f)).message, /実行中/);
  unblock('task');
  await first;
});
test('夜間バッチは既存digest経路をLINE集計の後に呼び、終了コードを記録', () => {
  const source = fs.readFileSync(new URL('./nightly-batch.ps1', import.meta.url), 'utf8');
  assert(source.indexOf('$dailyNotices = $null') > source.indexOf("tools\\line-digest.mjs"));
  assert.match(source, /\$dailyNotices --daily-notices/);
  assert.match(source, /Write-NightlyStepResult 'daily-notices' \$noticeExit \$noticeOutput/);
});
