import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyKim } from './notify-kim.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'notify-kim-quota-')); }
function response({ ok = true, status = 200, json = {} } = {}) { return { ok, status, json: async () => json }; }
function sender(dir) {
  const messages = [];
  return { messages, options: { home: dir, token: 'token', userId: 'user', plainJa: false, fetchImpl: async (url, init) => {
    if (url.endsWith('/messages')) messages.push(JSON.parse(init.body).content);
    return response({ json: { id: 'dm' } });
  } } };
}
const GOAL = '[handoff-audit:6d4ea6ec4a15cedf] quota-sweep claude: window-info の連続失敗 — 再発していないかを実物で検証する';
const report = (outcome, extra = {}) => [
  'claude/5h',
  `${extra.usedBefore ?? 4}% → ${extra.usedAfter ?? 5}%`,
  `tick: ${extra.ticks ?? 2}`,
  GOAL,
  extra.prUrl || '変更なし',
  outcome,
  extra.reason ? `理由: ${extra.reason}` : '検証完了',
].join('\n');
const todoFile = dir => path.join(dir, '.claude/next-session.md');

test('quota-sweep の deferred 通知は目的文に「失敗」があっても起票しない', async () => {
  const dir = home(), s = sender(dir);
  assert.equal((await notifyKim(report('deferred', { reason: '利用窓を読めない一時障害のため次回へ延期: HTTP 429' }), s.options)).delivered, 'dm');
  assert.equal(fs.existsSync(todoFile(dir)), false);
});

test('quota-sweep の final / 成果あり・未完了 通知は起票しない', async () => {
  for (const outcome of ['final', '成果あり・未完了']) {
    const dir = home(), s = sender(dir);
    await notifyKim(report(outcome, { usedAfter: '?', prUrl: outcome === 'final' ? '' : 'https://github.com/kimkon1011/orgiast-claude-rules/pull/1' }), s.options);
    assert.equal(fs.existsSync(todoFile(dir)), false, outcome);
  }
});

test('quota-sweep の failed 通知は従来どおり起票する', async () => {
  const dir = home(), s = sender(dir);
  await notifyKim(report('failed', { usedAfter: '?', reason: '利用窓情報が不足または不正: [] (HTTP 429)' }), s.options);
  assert.match(fs.readFileSync(todoFile(dir), 'utf8'), /通知の原因調査・修復:/);
});

test('deadline / ceiling / exhausted は人の判断が要る停止なので起票する', async () => {
  for (const outcome of ['deadline', 'ceiling', 'exhausted']) {
    const dir = home(), s = sender(dir);
    await notifyKim(report(outcome, { reason: '制限時間または利用率の上限に到達' }), s.options);
    assert.match(fs.readFileSync(todoFile(dir), 'utf8'), /通知の原因調査・修復:/, outcome);
  }
});

test('quota-sweep 形式でない本文は従来どおり失敗として起票する', async () => {
  const dir = home(), s = sender(dir);
  await notifyKim('quota-sweep claude が直近 4 件すべて失敗している', s.options);
  assert.match(fs.readFileSync(todoFile(dir), 'utf8'), /通知の原因調査・修復:/);
});
