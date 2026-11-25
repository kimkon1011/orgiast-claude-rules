import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFleet, extractIdentity, maskEmailAddress } from './fleet-discord-audit.mjs';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const messages = [
  { timestamp: '2026-08-27T00:00:00.000Z', content: '**💻 Claude Code ローカル利用トークン** — 制作PC-01\n🖥 hostname=DESKTOP-A / user=sato / git=sato@orgiast.jp' },
  { timestamp: '2026-08-25T12:00:00.000Z', content: '▶ **[制作PC-01]** 定期報告\n🖥 hostname=DESKTOP-A / user=sato / git=sato@orgiast.jp' },
  { timestamp: '2026-08-24T11:59:59.000Z', content: '⚠ **[共用ラベル]** 報告\n🖥 hostname=DESKTOP-B / user=kim / git=kim@orgiast.jp' },
  { timestamp: '2026-08-27T11:00:00.000Z', content: '▶ **[別ラベル]** 報告\n🖥 hostname=DESKTOP-A / user=sato / git=sato@orgiast.jp' },
];

test('extractIdentity は3形式のlabelと端末情報を抽出する', () => {
  assert.deepEqual(extractIdentity(messages[0].content), { label: '制作PC-01', hostname: 'DESKTOP-A', user: 'sato', gitEmail: 'sato@orgiast.jp' });
  assert.equal(extractIdentity(messages[1].content).label, '制作PC-01');
  assert.equal(extractIdentity(messages[2].content).label, '共用ラベル');
  assert.deepEqual(extractIdentity('情報なし'), { label: '', hostname: '', user: '', gitEmail: '' });
});

test('メールアドレスは明示時だけマスクする', () => {
  assert.equal(maskEmailAddress('sato@orgiast.jp'), 's***@orgiast.jp');
  assert.equal(extractIdentity(messages[0].content, { maskEmail: true }).gitEmail, 's***@orgiast.jp');
  assert.equal(extractIdentity(messages[0].content).gitEmail, 'sato@orgiast.jp');
});

test('auditFleet はlabel/hostname別に集計し固定時刻で分類する', () => {
  const audit = auditFleet(messages, NOW);
  assert.deepEqual({ ...audit.labels['制作PC-01'] }, {
    first: '2026-08-25T12:00:00.000Z', last: '2026-08-27T00:00:00.000Z', count: 2,
    status: 'fresh', elapsedMs: 12 * 3_600_000,
  });
  assert.equal(audit.labels['共用ラベル'].status, 'silent');
  assert.equal(audit.hostnames['DESKTOP-B'].status, 'silent');
  assert.deepEqual(audit.labelToHostnames['制作PC-01'], ['DESKTOP-A']);
  assert.deepEqual(audit.hostnameToLabels['DESKTOP-A'], ['制作PC-01', '別ラベル']);
});

test('24hと72hちょうどはそれぞれfreshとstaleになる', () => {
  const audit = auditFleet([
    { timestamp: '2026-08-26T12:00:00.000Z', content: '▶ **[24h]**' },
    { timestamp: '2026-08-24T12:00:00.000Z', content: '▶ **[72h]**' },
  ], NOW);
  assert.equal(audit.labels['24h'].status, 'fresh');
  assert.equal(audit.labels['72h'].status, 'stale');
});
