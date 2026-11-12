import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectActiveSessions, summarize, writeReport, pushContext, main, LATEST_FILE } from './progress-push.mjs';
import { writeLedger, ledgerFile } from './auto-progress-ledger.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-push-push-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function seedLedger(home, rows) {
  const file = ledgerFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeLedger(file, rows);
}

test('collectActiveSessions returns open rows within 48h, excluding unattended', t => {
  const home = fixture(t);
  const now = Date.parse('2026-11-12T10:00:00Z');
  const rows = [
    { ts: new Date(now - 1 * 3600000).toISOString(), sessionId: 'aaa11111', promise: 'テスト1を完了', status: 'open', cwd: home },
    { ts: new Date(now - 24 * 3600000).toISOString(), sessionId: 'bbb22222', promise: 'テスト2を完了', status: 'open', cwd: home },
    { ts: new Date(now - 72 * 3600000).toISOString(), sessionId: 'ccc33333', promise: '古いテスト', status: 'open', cwd: home },
    { ts: new Date(now - 2 * 3600000).toISOString(), sessionId: 'ddd44444', promise: '無人テスト', status: 'open', cwd: 'C:\\Windows\\System32' },
    { ts: new Date(now - 2 * 3600000).toISOString(), sessionId: 'eee55555', promise: '完了済み', status: 'done', cwd: home },
  ];
  seedLedger(home, rows);
  const active = collectActiveSessions({ home, now });
  assert.equal(active.length, 2, '48h以内かつ有人のopen行のみ');
  assert.ok(active.some(r => r.sessionId === 'aaa11111'));
  assert.ok(active.some(r => r.sessionId === 'bbb22222'));
  assert.ok(!active.some(r => r.sessionId === 'ccc33333'), '72h超は対象外');
  assert.ok(!active.some(r => r.sessionId === 'ddd44444'), '無人は対象外');
  assert.ok(!active.some(r => r.sessionId === 'eee55555'), '完了は対象外');
});

test('summarize produces report with items from active sessions', t => {
  const home = fixture(t);
  const now = Date.parse('2026-11-12T10:00:00Z');
  const sessions = [
    { ts: new Date(now - 1 * 3600000).toISOString(), sessionId: 'aaa11111', promise: 'テスト1を完了', status: 'open', label: 'テスト1', cwd: home },
    { ts: new Date(now - 3 * 3600000).toISOString(), sessionId: 'bbb22222', promise: 'テスト2を確認', status: 'waiting_user', label: 'テスト2', cwd: home },
  ];
  const report = summarize(sessions, { home, now, label: 'test-PC' });
  assert.equal(report.activeCount, 2);
  assert.equal(report.label, 'test-PC');
  assert.ok(report.items[0].sessionId);
  assert.equal(report.items[1].statusLabel, '判断待ち');
});

test('writeReport creates progress-push/latest.json with correct content', t => {
  const home = fixture(t);
  const report = { at: '2026-11-12T10:00:00Z', label: 'test-PC', activeCount: 1, items: [{ sessionId: 'aaa11111', statusLabel: '進行中', summary: '作業中' }] };
  const file = writeReport(home, report);
  assert.equal(file, LATEST_FILE(home));
  assert.ok(fs.existsSync(file));
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(loaded.activeCount, 1);
  assert.equal(loaded.label, 'test-PC');
});

test('pushContext generates one-line summary for active items', t => {
  const report = {
    items: [
      { sessionId: 'aaa11111', label: 'テスト1', statusLabel: '進行中', ago: '1時間前' },
      { sessionId: 'bbb22222', label: 'テスト2', statusLabel: '判断待ち', ago: '3時間前' },
    ],
  };
  const context = pushContext(report);
  assert.match(context, /定期進捗プッシュ/);
  assert.match(context, /進行中/);
  assert.match(context, /判断待ち/);
});

test('pushContext returns empty for no items', t => {
  assert.equal(pushContext({ items: [] }), '');
});

test('main writes report and returns ok; fail-open on bad home', t => {
  const home = fixture(t);
  const result = main({ home });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.path));
  assert.equal(result.activeCount, 0);

  // fail-open: nonexistent home でもクラッシュせず ok（readLedger が ENOENT を無視）
  const bad = main({ home: path.join(os.tmpdir(), 'nonexistent-' + Date.now()) });
  assert.equal(bad.ok, true);
  assert.equal(bad.activeCount, 0);
});

test('counter-only sessions and open inbox are collected; corrupt counter is ignored', t => {
  const home = fixture(t), now = Date.now();
  const dir = path.join(home, '.claude', '.intra-turn-progress-counter');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'counter-session.json'), JSON.stringify({ count: 1, updatedAt: now }));
  fs.writeFileSync(path.join(dir, 'old-session.json'), JSON.stringify({ updatedAt: now - 3 * 3600000 }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  const inbox = path.join(home, '.claude', 'kim-inbox');
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, 'ki-20261112000000-abcd.json'), JSON.stringify({ id: 'ki-20261112000000-abcd', status: 'open', shownSessions: [], shownCount: 0, kind: 'ask', sessionId: 'inbox-session', text: '確認の返事待ち', createdAt: new Date(now).toISOString() }));
  const sessions = collectActiveSessions({ home, now });
  assert.deepEqual(sessions.map(r => r.sessionId).sort(), ['counter-session', 'inbox-session']);
  assert.equal(main({ home, now }).activeCount, 2);
  const first = fs.readFileSync(LATEST_FILE(home), 'utf8');
  assert.equal(main({ home, now: now + 3599999 }).skipped, true);
  assert.equal(fs.readFileSync(LATEST_FILE(home), 'utf8'), first);
  assert.equal(main({ home, now: now + 3600000 }).skipped, undefined);
});

test('unwritable report path is fail-open', t => {
  const home = fixture(t);
  fs.writeFileSync(path.join(home, '.claude'), 'blocked');
  assert.equal(main({ home }).ok, false);
});

 test('heartbeat precedes high priority asks even when asks were created first', async t => {
  const { selectContext } = await import('./kim-inbox.mjs');
  const home = fixture(t), now = Date.now();
  const base = { status: 'open', createdAt: new Date(now).toISOString(), shownCount: 0, shownSessions: [], from: 'test' };
  const ask = { ...base, id: 'ask-first', kind: 'ask', priority: 'high', source: 'test', text: 'ASK-MARKER' };
  const heartbeat = { ...base, id: 'heartbeat', kind: 'info', source: 'auto-progress-heartbeat', text: 'PROGRESS-MARKER' };
  const text = selectContext([ask, heartbeat], { home, sessionId: 'test-session', now });
  assert.ok(text.indexOf('PROGRESS-MARKER') >= 0);
  assert.ok(text.indexOf('PROGRESS-MARKER') < text.indexOf('ASK-MARKER'));
 });
