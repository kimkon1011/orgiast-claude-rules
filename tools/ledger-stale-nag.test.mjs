import test from 'node:test';
import assert from 'node:assert/strict';
import { runLedgerNag } from './ledger-stale-nag.mjs';

const NOW = new Date('2026-10-01T09:00:00Z');
const row = (age, fields = {}) => ({ taskId: 'assign-app-pr1', 件名: 'レビュー・Approve・Merge', 担当PC: 'cr568アカウント', 状態: '依頼中', 次アクション: 'レビューする', 成果物リンク: 'https://example.test/pr/1', 最終更新: new Date(NOW.getTime() - age * 3600000).toISOString(), ...fields });
function harness(rows, state = {}) {
  const stdout = [], sends = [], writes = [];
  return {
    stdout, sends, writes,
    options: {
      args: [], home: '/unused', env: { DISCORD_BOT_TOKEN: 'test-token' }, now: NOW,
      list: async (args) => { assert.deepEqual(args, { command: 'list' }); return { ok: true, rows }; },
      sendDm: async (message) => sends.push(message),
      io: { read: () => JSON.stringify(state), write: (file, text) => writes.push(JSON.parse(text)), stdout: (text) => stdout.push(text) },
    },
  };
}

test('24時間未満・ちょうど24時間は通知しない', async () => {
  const h = harness([row(23), row(24, { taskId: 'boundary' })]);
  assert.equal(await runLedgerNag(h.options), 0);
  assert.equal(h.sends.length, 0);
  assert.deepEqual(JSON.parse(h.stdout[0]), { ok: true, notified: 0 });
});
test('24時間超はkimへ通知し履歴を保存する', async () => {
  const h = harness([row(51)]);
  await runLedgerNag(h.options);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].userId, '715210673642012733');
  assert.match(h.sends[0].content, /停滞: 2日3時間/);
  assert.equal(h.writes[0]['assign-app-pr1'], NOW.toISOString());
});
test('クールダウン内はスキップ、ちょうど24時間は再通知する', async () => {
  const h = harness([row(80), row(80, { taskId: 'again' })], { 'assign-app-pr1': new Date(NOW.getTime() - 3600000).toISOString(), again: new Date(NOW.getTime() - 24 * 3600000).toISOString() });
  await runLedgerNag(h.options);
  assert.doesNotMatch(h.sends[0].content, /assign-app-pr1/);
  assert.match(h.sends[0].content, /again/);
  assert.match(h.sends[0].content, /⚠️ 長期停滞/);
});
test('0件なら送信関数も履歴書き込みも呼ばない', async () => {
  const h = harness([]);
  await runLedgerNag(h.options);
  assert.equal(h.sends.length, 0);
  assert.equal(h.writes.length, 0);
});
test('2000字超では停滞順の上位5件と他N件に丸め、表示分だけ記録する', async () => {
  const h = harness(Array.from({ length: 12 }, (_, i) => row(30 + i, { taskId: `task-${i}`, 件名: '長'.repeat(1000), 次アクション: '次'.repeat(200), 成果物リンク: `https://example.test/${'x'.repeat(2000)}` })));
  await runLedgerNag(h.options);
  const content = h.sends[0].content;
  assert.ok(content.length <= 2000);
  assert.equal((content.match(/^- /gm) || []).length, 5);
  assert.match(content, /他7件$/);
  assert.match(content, /task-11/);
  assert.doesNotMatch(content, /task-6\]/);
  assert.equal(Object.keys(h.writes[0]).length, 5);
});
test('dry-runは本文だけ出し送信も履歴更新もしない', async () => {
  const h = harness([row(25)]);
  await runLedgerNag({ ...h.options, args: ['--dry-run'] });
  assert.match(h.stdout[0], /^📋 共有タスク台帳/);
  assert.equal(h.sends.length, 0);
  assert.equal(h.writes.length, 0);
});
test('3状態だけ対象にし、不正日時・未来日時を除外する', async () => {
  const h = harness(['依頼中', '未着手', '対応中', '完了'].map((状態, i) => row(50, { taskId: String(i), 状態 })).concat([row(50, { taskId: 'bad', 最終更新: 'bad' }), row(-1, { taskId: 'future' })]));
  await runLedgerNag(h.options);
  assert.equal(JSON.parse(h.stdout[0]).notified, 3);
});
test('環境変数でしきい値とクールダウンを変更できる', async () => {
  const h = harness([row(3)], { 'assign-app-pr1': new Date(NOW.getTime() - 2 * 3600000).toISOString() });
  await runLedgerNag({ ...h.options, env: { ...h.options.env, LEDGER_NAG_WARN_HOURS: '1', LEDGER_NAG_CRITICAL_HOURS: '2', LEDGER_NAG_COOLDOWN_HOURS: '1' } });
  assert.match(h.sends[0].content, /⚠️ 長期停滞/);
});
test('送信失敗時は履歴を更新しない', async () => {
  const h = harness([row(25)]);
  await assert.rejects(runLedgerNag({ ...h.options, sendDm: async () => { throw new Error('send failed'); } }), /send failed/);
  assert.equal(h.writes.length, 0);
});
