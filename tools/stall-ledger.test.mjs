import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHandoffMarkdown, chooseHandoffTarget, collectGbReportEntries, handoffSession, ledgerSummary, parseStallSummary, renderAllLedgers, stallSummaryStep, writeStallLedger } from './stall-ledger.mjs';

const NOW = Date.parse('2026-11-25T03:00:00Z');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stall-ledger-'));

test('台帳を書き、24h期日と打ち切りを集計する', t => {
  const home = temp(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = writeStallLedger({ home, hostname: '000KimPC', now: NOW, entries: [
    { title: '期限', sessionId: 'a', due: NOW + 3_600_000, type: '期限切れ' },
    { title: '停止', sessionId: 'b', type: '打ち切り' },
  ] });
  assert.deepEqual(result.summary, { total: 2, due24h: 1, cutOff: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.file)).summary, result.summary);
});

test('beacon の既存 steps に件数を載せ、受信側で復元する', () => {
  const step = stallSummaryStep({ total: 5, due24h: 2, cutOff: 1 });
  assert.deepEqual(parseStallSummary([step]), { total: 5, due24h: 2, cutOff: 1 });
  assert.equal(step.status, 'fail');
});

test('ALL.md は未対応PCを未対応と明記し、嘘の0件を書かない', () => {
  const md = renderAllLedgers({ ownLedger: { hostname: '000KimPC', summary: { total: 1, due24h: 0, cutOff: 0 } }, fleetRows: [{ label: '004', hostname: '004PC', stallLedger: null }] });
  assert.match(md, /004PC \| - \| - \| - \| beacon 未対応/);
});

test('000 の gb-reports は7日以内かつDONEなしだけ拾う', t => {
  const root = temp(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['open', 'done', 'old']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'done', 'DONE.txt'), 'done');
  fs.utimesSync(path.join(root, 'open'), new Date(NOW - 2 * 86_400_000), new Date(NOW - 2 * 86_400_000));
  fs.utimesSync(path.join(root, 'old'), new Date(NOW - 8 * 86_400_000), new Date(NOW - 8 * 86_400_000));
  assert.deepEqual(collectGbReportEntries({ reportsDir: root, now: NOW }).map(x => x.title), ['open']);
});

test('利用率が低く最近生きている許可PCを選ぶ', () => {
  const rows = [
    { label: '004-PC', hasBeacon: true, stale: false, pollAt: new Date(NOW - 1000).toISOString(), planFiveHourPct: 90 },
    { label: '011-PC', hasBeacon: true, stale: false, pollAt: new Date(NOW - 2000).toISOString(), planFiveHourPct: 20 },
  ];
  assert.equal(chooseHandoffTarget(rows, { selfHostname: '000KimPC', now: NOW })?.label, '011-PC');
});

test('引き継ぎ本文は秘密をマスクし、directive を1回呼ぶ', t => {
  const home = temp(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const record = { title: '案件', sessionId: 'sid', hostname: '000KimPC', firstUserText: 'token=secret-value-1234567890', lastAssistantText: '停止' };
  assert.doesNotMatch(buildHandoffMarkdown(record), /secret-value/);
  const calls = [];
  const result = handoffSession({ home, repo: home, now: NOW, record, fleetRows: [{ label: '011-PC', hasBeacon: true, stale: false, pollAt: new Date(NOW).toISOString(), planFiveHourPct: 10 }], directiveSender: (...args) => { calls.push(args); return { id: 'd1' }; } });
  assert.equal(result.handedOff, true); assert.equal(calls.length, 1); assert.ok(calls[0][0].includes('--push'));
});
