#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  main,
  loadLocalStore,
  decideAction,
  setRowStatus,
  AI_FOOTER,
  toIsoJst,
  parseArgs,
  computeDue,
  isSamePc,
  isOwnerPcMatch,
  expandPcNames,
  loadFleetPcMap,
  renderAlert,
  rowFromArgs,
  isMissingChatId,
  resolveNow,
  HEADERS,
  FIELDS,
  isOffSiteTask,
  siteConstraint,
  CAFE_SOLO_REASON,
} from './followup-ledger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `followup-${name}-`));
  return dir;
}

function writeMock(dir, data) {
  const file = path.join(dir, 'mock.json');
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

function baseEnv(dir, mockFile, extra = {}) {
  return {
    ...process.env,
    FOLLOWUP_ADAPTER: 'mock',
    FOLLOWUP_MOCK_FILE: mockFile,
    FOLLOWUP_LEDGER_HOME: dir,
    FOLLOWUP_PC: 'test-pc',
    ...extra,
  };
}

function baseConfig(dir, overrides = {}) {
  return {
    spreadsheetId: '',
    url: '',
    owner: 'seisaku-team@orgiast.jp',
    approvalChannelId: 'approval-chan',
    approverUserIds: overrides.approverUserIds || ['approver-1'],
    approvalTimeoutMinutes: 120,
    quietHours: { start: '22:00', end: '07:00', tz: 'Asia/Tokyo' },
    alertFile: path.join(dir, 'ALERT.md'),
    pcAliases: { '000': 'kim-PC', '011': '作業用011' },
    ...overrides,
  };
}

async function withEnv(env, fn) {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key];
    }
    Object.assign(process.env, prev);
  }
}

function pastIso(minutesAgo = 120) {
  return toIsoJst(new Date(Date.now() - minutesAgo * 60_000));
}

function addArgs(id, overrides = {}) {
  return [
    'add',
    '--store', 'local',
    '--id', id,
    '--to', overrides.to || '相手さん',
    '--channel', overrides.channel || 'beeper',
    '--chat', overrides.chat ?? 'chat-1',
    '--scope', overrides.scope || 'internal',
    '--task', overrides.task || '追跡番号を教えてください',
    '--done-when', overrides.doneWhen || '追跡番号あり',
    '--done-pattern', overrides.donePattern || String.raw`\d{4}-\d{4}-\d{4}`,
    '--interval', String(overrides.interval ?? 0),
    '--due', overrides.due || pastIso(60),
    '--renudge', String(overrides.renudge ?? 30),
    '--max-nudges', String(overrides.maxNudges ?? 3),
    '--escalate', overrides.escalate || 'kim-inbox',
    '--owner-ai', 'test-ai',
    '--owner-pc', 'test-pc',
    '--requested-at', overrides.requestedAt || pastIso(180),
    ...(overrides.extra || []),
  ];
}

test('parseArgs / computeDue / decideAction basics', () => {
  const p = parseArgs(['check', '--id', 'X', '--dry-run']);
  assert.equal(p._[0], 'check');
  assert.equal(p.flags.id, 'X');
  assert.equal(p.flags['dry-run'], true);
  // Empty string value must stay empty (not boolean true)
  const emptyChat = parseArgs(['add', '--chat', '', '--task', 't']);
  assert.equal(emptyChat.flags.chat, '');
  assert.notEqual(emptyChat.flags.chat, true);
  const eqEmpty = parseArgs(['add', '--chat=', '--to', 'x']);
  assert.equal(eqEmpty.flags.chat, '');
  // PowerShell drops '' → flag becomes true; rowFromArgs must treat as missing
  assert.equal(isMissingChatId(true), true);
  assert.equal(isMissingChatId('true'), true);
  assert.equal(isMissingChatId(''), true);
  assert.equal(isMissingChatId('未確認（Beeper未解決）'), true);
  assert.equal(isMissingChatId('mock-chat-A'), false);
  const stalled = rowFromArgs({
    id: 'C2', channel: 'beeper', chat: true, to: 'x', task: 't',
  }, { now: new Date('2026-11-27T15:00:00+09:00') });
  assert.equal(stalled.status, '止まった');
  assert.equal(stalled.statusReason, 'chatID不明');
  assert.equal(stalled.chatId, '');
  assert.equal(stalled.nextCheckAt, toIsoJst(new Date('2026-11-27T15:00:00+09:00')));
  const due = computeDue({ dueAt: '2020-01-01T00:00:00+09:00' });
  assert.ok(due < Date.now());
  const act = decideAction({
    status: '依頼中',
    dueAt: pastIso(10),
    renudgeMin: 1,
    requestedAt: pastIso(60),
    maxNudges: 3,
    nudgeCount: 0,
    scope: 'internal',
    channel: 'beeper',
    donePattern: String.raw`\d{4}-\d{4}-\d{4}`,
  }, [], new Date());
  assert.equal(act.action, 'nudge');
  assert.ok(resolveNow('2026-11-27T15:00:00+09:00') instanceof Date);
});

test('A: overdue no-reply → one nudge with footer; second check no duplicate', async () => {
  const dir = tmpDir('a');
  const now = new Date('2026-11-27T14:00:00+09:00');
  const mockFile = writeMock(dir, { replies: { 'chat-1': [] }, fail: {}, sent: [] });
  const config = baseConfig(dir, { quietHours: { start: '00:00', end: '00:00', tz: 'Asia/Tokyo' } }); // Disable quiet hours for this test
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(addArgs('A1', { due: toIsoJst(new Date(now - 3600000)), requestedAt: toIsoJst(new Date(now - 10800000)) }), { config, storeMode: 'local', now, spawn: () => ({ status: 0, stdout: '[]' }) });
    const r1 = await main(['check', '--store', 'local'], {
      config, storeMode: 'local', now, spawn: () => ({ status: 0, stdout: '[]' }),
    });
    void r1;
    const mock1 = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.equal(mock1.sent.length, 1);
    assert.match(mock1.sent[0].text, new RegExp(AI_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const store1 = loadLocalStore(path.join(dir, 'ledger.json'));
    const row1 = store1.items.find((i) => i.id === 'A1');
    assert.equal(row1.status, '催促済み');
    assert.equal(Number(row1.nudgeCount), 1);

    // Force next check immediately
    row1.nextCheckAt = toIsoJst(new Date(now - 60000));
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(store1, null, 2));

    await main(['check', '--store', 'local'], {
      config, storeMode: 'local', now, spawn: () => ({ status: 0, stdout: '[]' }),
    });
    const mock2 = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.equal(mock2.sent.length, 1, '二重送信しない');
    const store2 = loadLocalStore(path.join(dir, 'ledger.json'));
    assert.ok(store2.history.some((h) => h.reason === '重複のため送らず'));
  });
});

test('B: done-pattern match → complete with evidence in history', async () => {
  const dir = tmpDir('b');
  const mockFile = writeMock(dir, {
    replies: {
      'chat-1': [{
        id: 'm1', at: toIsoJst(), from: '相手', text: '追跡番号は 1234-5678-9012 です', isSelf: false,
      }],
    },
    fail: {},
    sent: [],
  });
  const config = baseConfig(dir);
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(addArgs('B1'), { config, storeMode: 'local', spawn: () => ({ status: 0, stdout: '[]' }) });
    await main(['check', '--store', 'local'], {
      config, storeMode: 'local', now: new Date(), spawn: () => ({ status: 0, stdout: '[]' }),
    });
    const store = loadLocalStore(path.join(dir, 'ledger.json'));
    const row = store.items.find((i) => i.id === 'B1');
    assert.equal(row.status, '完了');
    assert.ok(store.history.some((h) => h.status === '完了' && /1234-5678-9012/.test(h.reason)));
  });
});

test('C(a): mock fail Beeper到達不可 → 止まった + escalate recorded (dry-run)', async () => {
  const dir = tmpDir('c-a');
  const mockFile = writeMock(dir, {
    replies: {},
    fail: { 'chat-1': 'Beeper到達不可: gateway down' },
    sent: [],
  });
  const config = baseConfig(dir);
  const escalations = [];
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(addArgs('C1'), { config, storeMode: 'local', spawn: () => ({ status: 0, stdout: '[]' }) });
    const summary = await main(['check', '--store', 'local', '--dry-run', '--json'], {
      config, storeMode: 'local', now: new Date(),
      spawn: () => ({ status: 0, stdout: '[]' }),
    });
    void summary;
    // re-run capturing via store
    const store = loadLocalStore(path.join(dir, 'ledger.json'));
    // dry-run check still updates status through processRow → escalate
    // Actually dry-run only skips kim-inbox spawn; status still set
  });
  // Direct process without dry-run but mock spawn
  await withEnv(baseEnv(dir, mockFile), async () => {
    const dir2 = tmpDir('c-a2');
    const mock2 = writeMock(dir2, {
      replies: {},
      fail: { 'chat-1': 'Beeper到達不可: gateway down' },
      sent: [],
    });
    process.env.FOLLOWUP_LEDGER_HOME = dir2;
    process.env.FOLLOWUP_MOCK_FILE = mock2;
    const cfg = baseConfig(dir2);
    await main(addArgs('C1b'), { config: cfg, storeMode: 'local', spawn: () => ({ status: 0, stdout: '[]' }) });
    // reset next check
    const s0 = loadLocalStore(path.join(dir2, 'ledger.json'));
    s0.items[0].nextCheckAt = pastIso(1);
    fs.writeFileSync(path.join(dir2, 'ledger.json'), JSON.stringify(s0, null, 2));
    const calls = [];
    await main(['check', '--store', 'local', '--dry-run'], {
      config: cfg, storeMode: 'local', now: new Date(),
      spawn: (...args) => { calls.push(args); return { status: 0, stdout: '[]' }; },
    });
    const store = loadLocalStore(path.join(dir2, 'ledger.json'));
    const row = store.items.find((i) => i.id === 'C1b');
    assert.equal(row.status, '止まった');
    assert.match(row.statusReason, /Beeper到達不可/);
    assert.equal(calls.length, 0, 'dry-run では kim-inbox を呼ばない');
    escalations.push(row.statusReason);
  });
  assert.ok(escalations.length);
});

test('C(b): chatID 未確認 → add 時に 止まった', async () => {
  const dir = tmpDir('c-b');
  const mockFile = writeMock(dir, { replies: {}, fail: {}, sent: [] });
  const config = baseConfig(dir);
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(addArgs('C2', { chat: '未確認（Beeper未解決）', extra: ['--dry-run'] }), {
      config, storeMode: 'local', spawn: () => ({ status: 0, stdout: '[]' }),
    });
    const store = loadLocalStore(path.join(dir, 'ledger.json'));
    const row = store.items.find((i) => i.id === 'C2');
    assert.equal(row.status, '止まった');
    assert.equal(row.statusReason, 'chatID不明');
  });
});

test('D: max nudges exceeded → escalate without send', async () => {
  const dir = tmpDir('d');
  const mockFile = writeMock(dir, { replies: { 'chat-1': [] }, fail: {}, sent: [] });
  const config = baseConfig(dir);
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(addArgs('D1', { maxNudges: 2, extra: [] }), {
      config, storeMode: 'local', spawn: () => ({ status: 0, stdout: '[]' }),
    });
    const store0 = loadLocalStore(path.join(dir, 'ledger.json'));
    const row0 = store0.items[0];
    row0.nudgeCount = 2;
    row0.status = '催促済み';
    row0.nextCheckAt = pastIso(1);
    row0.lastSentAt = pastIso(120);
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(store0, null, 2));
    await main(['check', '--store', 'local', '--dry-run'], {
      config, storeMode: 'local', now: new Date(),
      spawn: () => ({ status: 0, stdout: '[]' }),
    });
    const store = loadLocalStore(path.join(dir, 'ledger.json'));
    const row = store.items.find((i) => i.id === 'D1');
    assert.equal(row.status, 'エスカレーション');
    const mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.equal(mock.sent.length, 0);
  });
});

test('E: external → approval request; OK <ID> from approver sends', async () => {
  const dir = tmpDir('e');
  const now = new Date('2026-11-27T14:00:00+09:00');
  const mockFile = writeMock(dir, { replies: { 'chat-ext': [], 'approval-chan': [] }, fail: {}, sent: [] });
  const config = baseConfig(dir, { approverUserIds: ['approver-1'], quietHours: { start: '00:00', end: '00:00', tz: 'Asia/Tokyo' } }); // Disable quiet hours for this test
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(addArgs('E1', { scope: 'external', chat: 'chat-ext', channel: 'beeper', due: toIsoJst(new Date(now - 3600000)), requestedAt: toIsoJst(new Date(now - 10800000)) }), {
      config, storeMode: 'local', now, spawn: () => ({ status: 0, stdout: '[]' }),
    });
    await main(['check', '--store', 'local'], {
      config, storeMode: 'local', now, spawn: () => ({ status: 0, stdout: '[]' }),
    });
    let store = loadLocalStore(path.join(dir, 'ledger.json'));
    let row = store.items.find((i) => i.id === 'E1');
    assert.equal(row.status, '承認待ち');
    let mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.ok(mock.sent.some((s) => s.chatId === 'approval-chan' && /OK E1/.test(s.text)));
    const approvalOnly = mock.sent.filter((s) => s.chatId === 'approval-chan');
    assert.equal(approvalOnly.length, 1);
    assert.equal(mock.sent.filter((s) => s.chatId === 'chat-ext').length, 0);

    // Inject OK from approver
    mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    mock.replies['approval-chan'] = [
      ...(mock.replies['approval-chan'] || []),
      {
        id: 'ok1',
        at: toIsoJst(new Date(Date.parse(row.lastSentAt) + 1000)),
        from: 'satou',
        authorId: 'approver-1',
        text: 'OK E1',
        isSelf: false,
      },
    ];
    fs.writeFileSync(mockFile, JSON.stringify(mock, null, 2));
    store = loadLocalStore(path.join(dir, 'ledger.json'));
    store.items[0].nextCheckAt = toIsoJst(new Date(now - 60000));
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(store, null, 2));

    await main(['check', '--store', 'local'], {
      config, storeMode: 'local', now, spawn: () => ({ status: 0, stdout: '[]' }),
    });
    mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.ok(mock.sent.some((s) => s.chatId === 'chat-ext'), '承認後に本体へ送信');
    store = loadLocalStore(path.join(dir, 'ledger.json'));
    row = store.items.find((i) => i.id === 'E1');
    assert.equal(row.status, '催促済み');
  });
});

test('F: 止まった without reason is rejected', () => {
  assert.throws(() => setRowStatus({ status: '依頼中' }, '止まった', ''), /状態理由/);
  assert.throws(() => setRowStatus({ status: '依頼中' }, 'エスカレーション', ''), /状態理由/);
});

test('G: ALERT written with timestamp even when 0 checked', async () => {
  const dir = tmpDir('g');
  const mockFile = writeMock(dir, { replies: {}, fail: {}, sent: [] });
  const config = baseConfig(dir);
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(['alert', '--store', 'local'], { config, storeMode: 'local' });
    const alert = fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8');
    assert.match(alert, /時刻: \d{4}-\d{2}-\d{2}T/);
    assert.match(alert, /確認件数: 0/);
    assert.match(alert, /止まった: 0件/);
    assert.match(alert, /エスカレーション: 0件/);
    assert.match(alert, /承認待ち: 0件/);
    assert.match(alert, /担当PC不在: 0件/);
  });
});

test('status --store local runs without throw', async () => {
  const dir = tmpDir('status');
  const mockFile = writeMock(dir, { replies: {}, fail: {}, sent: [] });
  const config = baseConfig(dir);
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(['status', '--store', 'local'], { config, storeMode: 'local' });
  });
});

test('H: non-owner PC does not send and does not change status', async () => {
  const dir = tmpDir('h-owner');
  const mockFile = writeMock(dir, { replies: { 'chat-1': [] }, fail: {}, sent: [] });
  const config = baseConfig(dir);
  await withEnv(baseEnv(dir, mockFile, { FOLLOWUP_PC: 'other-pc' }), async () => {
    await main(addArgs('H1', { extra: [] }), {
      config, storeMode: 'local', spawn: () => ({ status: 0, stdout: '[]' }),
    });
    const before = loadLocalStore(path.join(dir, 'ledger.json'));
    const rowBefore = before.items.find((i) => i.id === 'H1');
    assert.equal(rowBefore.status, '依頼中');
    const statusBefore = rowBefore.status;
    const nudgeBefore = rowBefore.nudgeCount;
    const checkedBefore = rowBefore.lastCheckedAt;

    await main(['check', '--store', 'local'], {
      config, storeMode: 'local', now: new Date(),
      spawn: () => ({ status: 0, stdout: '[]' }),
      hostname: 'other-pc',
    });
    const mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.equal(mock.sent.length, 0, '担当外は送らない');
    const after = loadLocalStore(path.join(dir, 'ledger.json'));
    const row = after.items.find((i) => i.id === 'H1');
    assert.equal(row.status, statusBefore);
    assert.equal(Number(row.nudgeCount), Number(nudgeBefore));
    assert.equal(row.lastCheckedAt, checkedBefore);
  });
});

test('I: non-owner stale lastCheckedAt appears in ALERT (watchdog)', async () => {
  const dir = tmpDir('i-watch');
  const mockFile = writeMock(dir, { replies: { 'chat-1': [] }, fail: {}, sent: [] });
  const config = baseConfig(dir);
  await withEnv(baseEnv(dir, mockFile, { FOLLOWUP_PC: 'watcher-pc' }), async () => {
    await main(addArgs('I1', { interval: 15 }), {
      config, storeMode: 'local', spawn: () => ({ status: 0, stdout: '[]' }),
    });
    const store0 = loadLocalStore(path.join(dir, 'ledger.json'));
    store0.items[0].lastCheckedAt = pastIso(24 * 60); // 1 day ago
    store0.items[0].nextCheckAt = pastIso(1);
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(store0, null, 2));

    await main(['check', '--store', 'local'], {
      config, storeMode: 'local', now: new Date(),
      spawn: () => ({ status: 0, stdout: '[]' }),
      hostname: 'watcher-pc',
    });
    const alert = fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8');
    assert.match(alert, /担当PC不在: 1件/);
    assert.match(alert, /担当PC test-pc がこの依頼を見ていない/);
    assert.match(alert, /I1/);
    const store = loadLocalStore(path.join(dir, 'ledger.json'));
    assert.ok(store.history.some((h) => h.id === 'I1' && h.reason === 'watchdog'));
    assert.equal(store.items[0].status, '依頼中', 'watchdog は状態を変えない');
  });
});

test('J: fleet-pc-map aliases match (000 / kim-PC / 000KIMPC)', () => {
  const pcMap = loadFleetPcMap();
  const pcAliases = { '000': 'kim-PC', '011': '作業用011' };
  const opts = { pcMap, pcAliases };
  assert.equal(isSamePc('000', '000KIMPC', opts), true);
  assert.equal(isSamePc('kim-PC', 'DESKTOP-2D0R4LI', opts), true);
  assert.equal(isSamePc('000KimPC', '000KIMPC', opts), true);
  assert.equal(isOwnerPcMatch('000', '000KIMPC', opts), true);
  assert.equal(isOwnerPcMatch('any', 'whatever', opts), true);
  assert.equal(isSamePc('011', '011NEXT', opts), true);
  const names = expandPcNames('000', opts);
  assert.ok(names.has('kim-pc') || names.has('000kimpc'));
});

test('K: seed nudgeText is used as nudge body', async () => {
  const dir = tmpDir('k-seed');
  const now = new Date('2026-11-27T14:00:00+09:00');
  const mockFile = writeMock(dir, { replies: { 'chat-1': [] }, fail: {}, sent: [] });
  const config = baseConfig(dir, { quietHours: { start: '00:00', end: '00:00', tz: 'Asia/Tokyo' } }); // Disable quiet hours for this test
  const seedFile = path.join(dir, 'seed.json');
  fs.writeFileSync(seedFile, JSON.stringify([{
    id: 'K1',
    to: '相手さん',
    channel: 'beeper',
    chatId: 'chat-1',
    scope: 'internal',
    task: '確認ください',
    doneWhen: 'OK',
    donePattern: 'OK',
    intervalMin: 0,
    dueAt: toIsoJst(new Date(now - 3600000)),
    renudgeMin: 30,
    maxNudges: 3,
    ownerPc: 'test-pc',
    ownerAi: 'test-ai',
    requestedAt: toIsoJst(new Date(now - 10800000)),
    nudgeText: '【専用催促】K1の件です',
  }]));
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(['seed', '--store', 'local', '--file', seedFile], {
      config, storeMode: 'local', now, spawn: () => ({ status: 0, stdout: '[]' }),
    });
    await main(['check', '--store', 'local'], {
      config, storeMode: 'local', now, spawn: () => ({ status: 0, stdout: '[]' }),
    });
    const mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.equal(mock.sent.length, 1);
    assert.match(mock.sent[0].text, /【専用催促】K1の件です/);
    assert.match(mock.sent[0].text, new RegExp(AI_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('L: add --nudge-text sets nudgeText; renderAlert table has counts', async () => {
  const dir = tmpDir('l-nudge');
  const mockFile = writeMock(dir, { replies: {}, fail: {}, sent: [] });
  const config = baseConfig(dir);
  await withEnv(baseEnv(dir, mockFile), async () => {
    await main(addArgs('L1', { extra: ['--nudge-text', '直接指定の催促文'] }), {
      config, storeMode: 'local', spawn: () => ({ status: 0, stdout: '[]' }),
    });
    const store = loadLocalStore(path.join(dir, 'ledger.json'));
    assert.equal(store.items[0].nudgeText, '直接指定の催促文');
  });
  const md = renderAlert({
    now: new Date('2026-11-27T12:00:00+09:00'),
    checked: 2,
    stalled: [{ id: 'S1', to: 'a', status: '止まった', statusReason: 'x', nextCheckAt: 't1' }],
    escalated: [{ id: 'E1', to: 'b', status: 'エスカレーション', statusReason: 'y', nextCheckAt: 't2' }],
    awaitingApproval: [{ id: 'A1', to: 'c', status: '承認待ち', statusReason: 'z', nextCheckAt: 't3' }],
    missingOwner: [{ id: 'M1', to: 'd', status: '依頼中', _alertReason: '担当PC 000 がこの依頼を見ていない（最終確認 なし）', nextCheckAt: 't4' }],
  });
  assert.match(md, /止まった: 1件/);
  assert.match(md, /エスカレーション: 1件/);
  assert.match(md, /承認待ち: 1件/);
  assert.match(md, /担当PC不在: 1件/);
  assert.match(md, /\| 依頼ID \| 依頼先 \| 担当者区分 \| 居住地・最寄り \| 状態 \| 理由 \| 次回確認 \|/);
  assert.match(md, /\| S1 \|/);
  assert.match(md, /\| M1 \|/);
});

test('M: --all-pcs processes non-owner rows', async () => {
  const dir = tmpDir('m-all');
  const now = new Date('2026-11-27T14:00:00+09:00');
  const mockFile = writeMock(dir, { replies: { 'chat-1': [] }, fail: {}, sent: [] });
  const config = baseConfig(dir, { quietHours: { start: '00:00', end: '00:00', tz: 'Asia/Tokyo' } }); // Disable quiet hours for this test
  await withEnv(baseEnv(dir, mockFile, { FOLLOWUP_PC: 'other-pc' }), async () => {
    await main(addArgs('M1', { due: toIsoJst(new Date(now - 3600000)), requestedAt: toIsoJst(new Date(now - 10800000)) }), {
      config, storeMode: 'local', now, spawn: () => ({ status: 0, stdout: '[]' }),
    });
    await main(['check', '--store', 'local', '--all-pcs'], {
      config, storeMode: 'local', now,
      spawn: () => ({ status: 0, stdout: '[]' }),
      hostname: 'other-pc',
    });
    const mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.equal(mock.sent.length, 1);
    const store = loadLocalStore(path.join(dir, 'ledger.json'));
    assert.equal(store.items[0].status, '催促済み');
  });
});

test('N: scenario.ps1 equivalent (TEST-A/B/C/C2) with FOLLOWUP_NOW daytime', async () => {
  // Mirrors C:\Users\kimko\gb-reports\followup-ledger-1127\tests\scenario.ps1
  // Fixed 15:00 JST so quietHours (22:00–07:00) never flaky at night.
  const dir = tmpDir('scenario');
  const now = new Date('2026-11-27T15:00:00+09:00');
  const past = toIsoJst(new Date(now.getTime() - 2 * 60 * 60_000));
  const req = toIsoJst(new Date(now.getTime() - 5 * 60 * 60_000));
  const replyAt = toIsoJst(new Date(now.getTime() - 30 * 60_000));
  const mockFile = writeMock(dir, {
    replies: {
      'mock-chat-B': [{
        id: 'm-b1', at: replyAt, from: 'tester-B',
        text: 'posted. tracking 1234-5678-9012', isSelf: false,
      }],
    },
    fail: { 'mock-chat-C': 'Beeper unreachable: mock gateway down' },
    sent: [],
  });
  const alertFile = path.join(dir, 'scenario-ALERT.md');
  const config = baseConfig(dir, { alertFile });
  const common = {
    channel: 'beeper',
    scope: 'internal',
    interval: 15,
    due: past,
    renudge: 60,
    maxNudges: 2,
    escalate: 'alert-file-only',
    requestedAt: req,
    extra: ['--owner-pc', 'scenario-pc'],
  };
  const spawn = () => ({ status: 0, stdout: '[]' });

  await withEnv(baseEnv(dir, mockFile, {
    FOLLOWUP_PC: 'scenario-pc',
    FOLLOWUP_NOW: toIsoJst(now),
  }), async () => {
    await main(addArgs('TEST-A', {
      ...common, to: 'tester-A', chat: 'mock-chat-A', task: 'TEST A overdue',
    }), { config, storeMode: 'local', now, spawn });
    await main(addArgs('TEST-B', {
      ...common, to: 'tester-B', chat: 'mock-chat-B', task: 'TEST B reply',
    }), { config, storeMode: 'local', now, spawn });
    await main(addArgs('TEST-C', {
      ...common, to: 'tester-C', chat: 'mock-chat-C', task: 'TEST C precondition',
    }), { config, storeMode: 'local', now, spawn });
    // PowerShell `--chat ''` drops the empty arg → `--chat` then next `--…` → boolean true
    await main([
      'add', '--store', 'local',
      '--id', 'TEST-C2',
      '--to', 'tester-C2',
      '--channel', 'beeper',
      '--chat',
      '--scope', 'internal',
      '--task', 'TEST C2 unknown chat id',
      '--done-when', 'tracking number',
      '--interval', '15',
      '--due', past,
      '--renudge', '60',
      '--max-nudges', '2',
      '--escalate', 'alert-file-only',
      '--owner-ai', 'test',
      '--owner-pc', 'scenario-pc',
      '--requested-at', req,
    ], { config, storeMode: 'local', now, spawn });

    const afterAdd = loadLocalStore(path.join(dir, 'ledger.json'));
    const c2 = afterAdd.items.find((i) => i.id === 'TEST-C2');
    assert.equal(c2.status, '止まった');
    assert.equal(c2.statusReason, 'chatID不明');
    assert.equal(c2.chatId, '');
    for (const id of ['TEST-A', 'TEST-B', 'TEST-C']) {
      const row = afterAdd.items.find((i) => i.id === id);
      assert.equal(row.nextCheckAt, toIsoJst(now), `${id} nextCheckAt should be now`);
    }

    await main(['check', '--store', 'local', '--alert-file', alertFile], {
      config, storeMode: 'local', now, spawn,
    });

    const mock1 = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.equal(mock1.sent.length, 1, 'TEST-A: first check sends one nudge');
    assert.match(mock1.sent[0].text, new RegExp(AI_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(mock1.sent[0].chatId, 'mock-chat-A');

    const store1 = loadLocalStore(path.join(dir, 'ledger.json'));
    const a1 = store1.items.find((i) => i.id === 'TEST-A');
    assert.equal(a1.status, '催促済み');
    assert.equal(Number(a1.nudgeCount), 1);

    const b1 = store1.items.find((i) => i.id === 'TEST-B');
    assert.equal(b1.status, '完了');
    assert.ok(store1.history.some((h) => h.id === 'TEST-B' && h.messageId === 'm-b1'));

    const c1 = store1.items.find((i) => i.id === 'TEST-C');
    assert.equal(c1.status, '止まった');
    assert.match(c1.statusReason, /到達不可|unreachable/i);
    const alert = fs.readFileSync(alertFile, 'utf8');
    assert.match(alert, /TEST-C/);
    assert.match(alert, /止まった/);

    assert.equal(store1.items.find((i) => i.id === 'TEST-C2').status, '止まった');

    await main(['check', '--store', 'local', '--alert-file', alertFile], {
      config, storeMode: 'local', now, spawn,
    });
    const mock2 = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    assert.equal(mock2.sent.length, 1, 'second check must not double-send');
  });
});

test('site constraint helpers and appended columns', () => {
  assert.equal(HEADERS.length, FIELDS.length);
  assert.deepEqual(HEADERS.slice(-3), ['担当者区分', '居住地・最寄り', '作業場所']);
  assert.equal(isOffSiteTask({ task: '郵便局で投函' }), true);
  assert.equal(isOffSiteTask({ task: '郵便局で投函', taskSite: 'in-store' }), false);
  assert.equal(isOffSiteTask({ task: '店内で確認', taskSite: 'off-site' }), true);
  assert.equal(siteConstraint({ assigneeRole: 'cafe-solo', task: '法務局へ訪問' }).blocked, true);
  assert.equal(siteConstraint({ assigneeRole: 'remote-assistant', task: '法務局へ訪問' }).blocked, false);
});

test('P: cafe-solo off-site is stopped, escalated, alerted, and never nudged', async () => {
  const dir = tmpDir('p-cafe');
  const now = new Date('2026-11-27T14:00:00+09:00');
  const mockFile = writeMock(dir, { replies: { 'chat-1': [] }, fail: {}, sent: [] });
  const bodies = [];
  const spawn = (_cmd, args) => {
    const bodyAt = args.indexOf('--body-file');
    if (bodyAt >= 0) bodies.push(fs.readFileSync(args[bodyAt + 1], 'utf8'));
    return { status: 0, stdout: '[]', stderr: '' };
  };
  const config = baseConfig(dir, { people: { 'ほなみ': { role: 'cafe-solo', location: '大阪・東邦ハイツ211（カフェ店内・一人勤務）' } } });
  await withEnv(baseEnv(dir, mockFile, { FOLLOWUP_NOW: toIsoJst(now) }), async () => {
    const task = 'セブンイレブンのネットプリントで印刷して簡易書留で投函';
    await main(addArgs('P1', { task, due: toIsoJst(new Date(now - 3600000)), requestedAt: toIsoJst(new Date(now - 7200000)), extra: ['--assignee-role', 'cafe-solo'] }), { config, storeMode: 'local', now, spawn });
    await main(addArgs('P2', { to: 'ほなみさん（LINE）', task, due: toIsoJst(new Date(now - 3600000)), requestedAt: toIsoJst(new Date(now - 7200000)) }), { config, storeMode: 'local', now, spawn });
    await main(['check', '--store', 'local'], { config, storeMode: 'local', now, spawn });
    await main(['nudge', '--store', 'local', '--id', 'P1', '--force'], { config, storeMode: 'local', now, spawn });
  });
  const mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
  const store = loadLocalStore(path.join(dir, 'ledger.json'));
  assert.equal(mock.sent.length, 0);
  assert.ok(store.items.every((r) => r.status === '止まった' && r.statusReason.includes('一人勤務')));
  assert.equal(store.items.find((r) => r.id === 'P2').assigneeRole, 'cafe-solo');
  assert.ok(bodies.some((b) => b.includes('付け替え: 店を離れられる担当')));
  assert.match(fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8'), /付け替えが必要/);
});

test('Q/R: in-store cafe and off-site remote assistant are nudged', async () => {
  const dir = tmpDir('qr');
  const now = new Date('2026-11-27T14:00:00+09:00');
  const mockFile = writeMock(dir, { replies: { 'chat-1': [] }, fail: {}, sent: [] });
  const config = baseConfig(dir);
  const old = toIsoJst(new Date(now - 3600000));
  await withEnv(baseEnv(dir, mockFile, { FOLLOWUP_NOW: toIsoJst(now) }), async () => {
    await main(addArgs('Q1', { task: '店にある書類（原本）の有無を返事してください', due: old, requestedAt: old, extra: ['--assignee-role', 'cafe-solo', '--site', 'in-store'] }), { config, storeMode: 'local', now });
    await main(addArgs('R1', { task: '最寄りの法務局で登記事項証明書を受け取り、レターパックで発送', due: old, requestedAt: old, extra: ['--assignee-role', 'remote-assistant', '--location', '福岡市（最寄り: 福岡法務局）'] }), { config, storeMode: 'local', now });
    await main(['check', '--store', 'local'], { config, storeMode: 'local', now });
  });
  const mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
  const store = loadLocalStore(path.join(dir, 'ledger.json'));
  assert.equal(mock.sent.length, 2);
  assert.equal(store.items.find((r) => r.id === 'Q1').status, '催促済み');
  assert.equal(store.items.find((r) => r.id === 'R1').status, '催促済み');
  assert.equal(store.items.find((r) => r.id === 'R1').assigneeLocation, '福岡市（最寄り: 福岡法務局）');
  assert.ok(!store.items.find((r) => r.id === 'R1').statusReason.includes(CAFE_SOLO_REASON));
});
