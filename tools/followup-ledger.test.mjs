#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  main, effectiveOwnerPc, normalizeOwnerAi, classifySheetError,
  validateEvidence, checkPrereq, readOutcome, evaluateOutcomeLiveness, rowToValues, valuesToRow,
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
  isPreShiftPickupMailException,
} from './followup-ledger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(path.dirname(__dirname), `.followup-test-${name}-`));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
    HOME: dir, USERPROFILE: dir, ORGIAST_HOME: dir,
    FOLLOWUP_ADAPTER: 'mock',
    FOLLOWUP_MOCK_FILE: mockFile,
    FOLLOWUP_LEDGER_HOME: dir,
    FOLLOWUP_PC: 'test-pc',
    FOLLOWUP_NOW: '2026-11-28T15:00:00+09:00',
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
    quietHours: { start: '00:00', end: '00:00', tz: 'Asia/Tokyo' },
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
    '--tema-check', overrides.temaCheck || '[TEMA-CHECK]\n候補: AI代行 / 本人作業\n選択: AI代行\n紙理由: なし\n手順数: 1\n読む量: 1通\n追加連絡: 次の連絡にまとめる\n前提: 所在=確認済み / 期限=確認済み / 順番=アシスタント確認済み\nAI代行: 不可\n[/TEMA-CHECK]',
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
    id: 'C2', channel: 'beeper', chat: true, to: 'x', task: 't', 'tema-check': '[TEMA-CHECK] 候補: A / B [/TEMA-CHECK]',
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
    temaCheck: '[TEMA-CHECK]\n候補: AI代行 / 本人作業\n選択: AI代行\n手順数: 1\n読む量: 1通\n追加連絡: 次の連絡にまとめる\n前提: 所在=確認済み\nAI代行: 不可\n[/TEMA-CHECK]',
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
      '--tema-check', '[TEMA-CHECK]\n候補: AI代行 / 本人作業\n選択: AI代行\n手順数: 1\n読む量: 1通\n追加連絡: 次の連絡にまとめる\n前提: 所在=確認済み\nAI代行: 不可\n[/TEMA-CHECK]',
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
  assert.deepEqual(HEADERS.slice(27, 31), ['担当者区分', '居住地・最寄り', '作業場所', '手間チェック記録']);
  assert.equal(isOffSiteTask({ task: '郵便局で投函' }), true);
  assert.equal(isOffSiteTask({ task: '郵便局で投函', taskSite: 'in-store' }), false);
  assert.equal(isOffSiteTask({ task: '店内で確認', taskSite: 'off-site' }), true);
  assert.equal(siteConstraint({ assigneeRole: 'cafe-solo', task: '法務局へ訪問' }).blocked, true);
  assert.equal(siteConstraint({ assigneeRole: 'remote-assistant', task: '法務局へ訪問' }).blocked, false);
  assert.equal(isPreShiftPickupMailException({ id: 'GB179-shaho-honami' }), true);
  assert.equal(isPreShiftPickupMailException({ id: 'GB179-shaho-yurie' }), false);
  assert.equal(siteConstraint({ id: 'GB179-shaho-honami', assigneeRole: 'cafe-solo', task: '11/30出勤前に受け取り、簡易書留で投函する', taskSite: 'off-site' }).blocked, false);
  assert.equal(siteConstraint({ id: 'GB179-shaho-honami', assigneeRole: 'cafe-solo', task: '11/30出勤前に受け取り、簡易書留で投函する', taskSite: 'off-site' }).exception, 'pre-shift-pickup-mail');
  assert.equal(siteConstraint({ id: 'GB179-shaho-yurie', assigneeRole: 'cafe-solo', task: '11/30出勤前に受け取り、簡易書留で投函する', taskSite: 'off-site' }).blocked, true);
  assert.equal(siteConstraint({ id: 'T3', assigneeRole: 'cafe-solo', task: '社保書類を郵便局で発送', taskSite: 'off-site' }).blocked, true);
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

async function outcomeScenario(name, fn, overrides = {}) {
  const dir = tmpDir(name);
  const mockFile = writeMock(dir, { replies: {}, fail: {}, sent: [] });
  const now = new Date('2026-11-28T13:00:00+09:00');
  const config = baseConfig(dir, { morningReportFile: path.join(dir, 'MORNING.md'), ...overrides });
  const ctx = { config, storeMode: 'local', now };
  await withEnv(baseEnv(dir, mockFile, { FOLLOWUP_NOW: toIsoJst(now) }), async () => {
    const run = (args, options = {}) => {
      if (options.now) process.env.FOLLOWUP_NOW = toIsoJst(options.now);
      return main(args, { ...ctx, ...options });
    };
    const add = (id, extra = [], options = {}) => run(addArgs(id, {
      due: '2026-11-28T10:00:00+09:00', requestedAt: '2026-11-25T13:00:00+09:00', interval: 15,
      ...options, extra,
    }));
    const store = () => loadLocalStore(path.join(dir, 'ledger.json'));
    const mock = () => JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    const replies = (chat, text) => {
      const data = mock();
      data.replies[chat] = [{ id: `reply-${chat}`, text, at: '2026-11-28T12:00:00+09:00', isSelf: false }];
      fs.writeFileSync(mockFile, JSON.stringify(data));
    };
    await fn({ dir, now, config, run, add, store, mock, replies });
  });
}

test('T1 人: なっちゃんの投函と追跡番号', async () => {
  await outcomeScenario('t1', async ({ add, run, store, mock, replies }) => {
    await add('T1-ok', ['--evidence-kind', 'tracking-number'], { to: 'なっちゃん', donePattern: '追跡番号', chat: 'tracking' });
    await add('T1-wait', ['--evidence-kind', 'tracking-number'], { donePattern: '追跡番号', chat: 'waiting' });
    replies('tracking', '追跡番号 1234-5678-9012 です');
    replies('waiting', '追跡番号はまだありません');
    assert.equal(await run(['complete', '--id', 'T1-wait', '--evidence', 'approved']), 2);
    assert.equal(store().items[1].status, '依頼中');
    await run(['check']);
    assert.equal(store().items[0].status, '完了');
    assert.equal(store().items[0].evidence, '1234-5678-9012');
    assert.equal(store().items[1].status, '依頼中');
    assert.equal(mock().sent.length, 1);
    assert.ok(store().history.some((h) => h.id === 'T1-ok' && h.reason.includes('1234-5678-9012')));
    await run(['check']);
    assert.equal(mock().sent.length, 1);
    assert.equal(validateEvidence('tracking-number', 'RR123456789JP').ok, true);
  });
});

test('T2 人: 学会事務局の返事', async () => {
  await outcomeScenario('t2', async ({ add, run, store, mock, replies, now }) => {
    await add('T2-ok', ['--evidence-kind', 'reply-text'], { donePattern: '受付しました', chat: 'office' });
    await add('T2-wait', ['--evidence-kind', 'reply-text'], { donePattern: '受付しました', chat: 'waiting', renudge: 5 });
    replies('office', '出展のお申込みを事務局にて受付しました。');
    await run(['check']);
    assert.equal(store().items[0].status, '完了');
    assert.match(store().items[0].evidence, /事務局/);
    assert.equal(mock().sent.length, 1);
    await run(['check'], { now: new Date(now.getTime() + 10 * 60_000) });
    assert.equal(mock().sent.length, 1, 'intervalMin前は再催促しない');
    await run(['check'], { now: new Date(now.getTime() + 16 * 60_000) });
    assert.equal(mock().sent.length, 2);
  });
});

test('T3 人: 社保書類 cafe-solo off-site は --force でも催促0', async () => {
  await outcomeScenario('t3', async ({ add, run, store, mock }) => {
    await add('T3', ['--assignee-role', 'cafe-solo', '--site', 'off-site'], { task: '社保書類を郵便局で発送' });
    await run(['nudge', '--id', 'T3', '--force']);
    assert.equal(mock().sent.length, 0);
    assert.equal(store().items[0].status, '止まった');
    assert.ok(mock().spawns.some((s) => s.body.includes('付け替え')));
  });
});

test('GB179-shaho-honami: 出勤前の受取・投函は cafe-solo off-site でも催促する（金さん 2026-11-28 例外）', async () => {
  await outcomeScenario('t3-preShift', async ({ add, run, store, mock }) => {
    await add('GB179-shaho-honami', ['--assignee-role', 'cafe-solo', '--site', 'off-site'], {
      task: '11/30出勤前に受け取り、簡易書留で投函する',
    });
    await run(['nudge', '--id', 'GB179-shaho-honami', '--dry-run']);
    assert.equal(mock().sent.length, 0);
    assert.notEqual(store().items[0].status, '止まった');
    assert.equal(store().items[0].statusReason.includes(CAFE_SOLO_REASON), false);
    await run(['nudge', '--id', 'GB179-shaho-honami']);
    assert.equal(mock().sent.length, 1);
    assert.ok(['依頼中', '催促済み'].includes(store().items[0].status));
  });
});

test('T4 Instagram: approved のまま postedAt 空・exit 0・トークン無し', async () => {
  await outcomeScenario('t4', async ({ dir, add, run, store, mock, now }) => {
    const queue = path.join(dir, 'queue');
    fs.mkdirSync(queue);
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(queue, `${i}.json`), JSON.stringify({ status: 'approved', postedAt: '' }));
    await add('T4', ['--kind', 'automation', '--outcome-source', `insta-queue:${queue}`, '--prereq', `file:${path.join(dir, '.env')}`, '--owner-pc', '015']);
    assert.equal(readOutcome(`insta-queue:${queue}`, { now }).pendingApproved, 6);
    await run(['outcome', '--id', 'T4', '--job-result', '0']);
    assert.equal(store().items[0].status, '止まった');
    assert.match(store().items[0].statusReason, /成果ゼロ.*ジョブ結果 0@.*承認済み未投稿 6件.*exit 0 や approved は完了ではない/);
    assert.equal(await run(['complete', '--id', 'T4']), 2);
    assert.equal(await run(['complete', '--id', 'T4', '--evidence', 'exitCode=0']), 2);
    assert.equal(mock().sent.length, 0);
    await run(['outcome', '--id', 'T4', '--prereq-missing', path.join(dir, '.env')]);
    assert.match(store().items[0].statusReason, /前提欠落/);
  });
});

test('T5 トークン欠落: .env.example のみ', async () => {
  await outcomeScenario('t5', async ({ dir, now, add, run, store, mock }) => {
    const prereq = path.join(dir, '.env');
    fs.writeFileSync(`${prereq}.example`, '# configuration example');
    await add('T5', ['--prereq', `file:${prereq}`, '--kim-only', '本人による連携の承認']);
    await run(['check']);
    await run(['check'], { now: new Date(now.getTime() + 16 * 60_000) });
    assert.equal(store().items[0].status, '止まった');
    assert.match(store().items[0].statusReason, /前提欠落.*金さんだけができること: 本人による連携の承認/);
    assert.equal(mock().sent.length, 0);
    assert.equal(mock().spawns.length, 1);
    assert.deepEqual(checkPrereq(store().items[0]), [prereq]);
    fs.writeFileSync(prereq, '# prerequisite exists; no secret');
    await run(['check'], { now: new Date(now.getTime() + 32 * 60_000) });
    assert.equal(store().items[0].status, '依頼中');
    assert.equal(store().items[0].statusReason, '前提が揃った');
  });
});

test('T6 (a) グロボが受けた依頼が朝の報告に載る', async () => {
  await outcomeScenario('t6', async ({ dir, add, run, store, mock }) => {
    await add('T6', ['--kind', 'globo', '--requested-by', '金さん', '--prereq', `file:${path.join(dir, 'missing')}`, '--kim-only', '本人認証', '--reassign-to', '担当AI']);
    await run(['check']);
    const spawn = () => { throw new Error('mockでは実行不可'); };
    await run(['report', '--morning', '--kim-inbox'], { spawn });
    await run(['report', '--morning', '--kim-inbox'], { spawn });
    const report = fs.readFileSync(path.join(dir, 'MORNING.md'), 'utf8');
    assert.match(report.split('## 止まった・期限超過')[0], /T6.*グロボ.*金さん.*本人認証.*担当AI/);
    assert.equal(mock().spawns.filter((s) => s.args.includes('followup-morning-20261128')).length, 1);
    assert.equal(store().history.filter((h) => h.reason === 'morning-report').length, 1);
    assert.equal(mock().sent.length, 0);
    await run(['report', '--kim-inbox', '--dry-run'], { now: new Date('2026-11-29T07:30:00+09:00'), spawn });
    assert.equal(store().history.filter((h) => h.reason === 'morning-report').length, 1);
  });
});

test('T7 (b) Claude Code が受けた依頼が同じ台帳に載り停滞が見える', async () => {
  await outcomeScenario('t7', async ({ dir, add, run, store }) => {
    await add('T7', ['--kind', 'claude-code', '--prereq', `file:${path.join(dir, 'missing')}`]);
    assert.equal(await run(['complete', '--id', 'T7']), 2);
    assert.equal(store().items[0].status, '依頼中');
    await run(['check']);
    await run(['report']);
    assert.match(fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8'), /T7/);
    assert.match(fs.readFileSync(path.join(dir, 'MORNING.md'), 'utf8'), /T7.*Claude Code/);
  });
});

test('T8 成果の生存確認: N日 exit 0 かつ実結果0で警告', async () => {
  await outcomeScenario('t8', async ({ dir, now, add, run, store }) => {
    const requestedAt = new Date(now.getTime() - 1.2 * 86_400_000).toISOString();
    const source = path.join(dir, 'outcome.json');
    fs.writeFileSync(source, JSON.stringify({ lastOutcomeAt: '', outcomes: [], pendingApproved: 4 }));
    await add('T8', ['--kind', 'automation', '--outcome-max-days', '2', '--outcome-source', `json:${source}`], { requestedAt });
    await run(['outcome', '--id', 'T8', '--job-result', '0']);
    const snapshot = readOutcome(`json:${source}`, { now });
    assert.equal(evaluateOutcomeLiveness(store().items[0], snapshot, now).state, 'warn');
    await run(['check']);
    assert.match(fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8'), /## 成果警告\n- T8/);
    await run(['report']);
    assert.match(fs.readFileSync(path.join(dir, 'MORNING.md'), 'utf8'), /成果警告/);
    const later = new Date(Date.parse(requestedAt) + 2.5 * 86_400_000);
    await run(['check'], { now: later });
    assert.equal(store().items[0].status, '止まった');
    assert.match(store().items[0].statusReason, /成果ゼロ: 2日以上.*ジョブ結果 0@/);
    const recent = { lastOutcomeAt: later.toISOString(), outcomes: [{ postedAt: later.toISOString(), postUrl: 'https://www.instagram.com/p/example/' }], pendingApproved: 0 };
    fs.writeFileSync(source, JSON.stringify(recent));
    await run(['check'], { now: new Date(later.getTime() + 16 * 60_000) });
    assert.equal(store().items[0].status, '依頼中');
    assert.equal(store().items[0].lastOutcomeAt, recent.lastOutcomeAt);
    assert.equal(evaluateOutcomeLiveness({ requestedAt, outcomeMaxDays: 0 }, snapshot, now, { outcomeDefaults: { maxDays: 4 } }).state, 'ok');
  });
});

test('T9 静穏時間: 確認は続行・社内催促は延期', async () => {
  await outcomeScenario('t9', async ({ add, run, store, mock, replies }) => {
    await add('T9');
    await add('T9-done', ['--evidence-kind', 'tracking-number'], { chat: 'completed' });
    replies('completed', '追跡番号 1234-5678-9012 です');
    const now = new Date('2026-11-28T23:30:00+09:00');
    await withEnv({ FOLLOWUP_NOW: toIsoJst(now) }, () => run(['check'], { now: undefined }));
    assert.equal(store().items[0].lastCheckedAt, toIsoJst(now));
    assert.ok(Date.parse(store().items[0].nextCheckAt) >= Date.parse('2026-11-29T07:00:00+09:00'));
    assert.equal(store().items[1].status, '完了');
    assert.equal(mock().sent.length, 0);
    await run(['nudge', '--id', 'T9', '--force'], { now });
    assert.ok(Date.parse(store().items[0].nextCheckAt) >= Date.parse('2026-11-29T07:00:00+09:00'));
  }, { quietHours: { start: '22:00', end: '07:00', tz: 'Asia/Tokyo' } });
});

test('T10 担当PC不在を黙ってスキップしない', async () => {
  await outcomeScenario('t10', async ({ dir, add, run, store, config, mock }) => {
    await add('T10', ['--owner-pc', '000']);
    const rows = store().items.map(rowToValues);
    const history = [];
    const writes = [];
    const structureWrites = [];
    let failHistory = false;
    const sheets = {
      metadata: async () => ({ sheets: [{ properties: { title: 'ledger', sheetId: 0, gridProperties: { columnCount: 31 } } }, { properties: { title: 'history' } }] }),
      updateStructure: async (_id, requests) => structureWrites.push(...requests),
      get: async (_id, range) => range.includes('1:') ? [range.includes('ledger') ? HEADERS : ['時刻']]
        : range.includes('ledger') ? structuredClone(rows) : structuredClone(history),
      update: async () => {},
      append: async (_id, range, values) => {
        if (failHistory) throw new Error('mock history append unavailable: HTTP 503');
        writes.push({ range, values: structuredClone(values) });
        history.push(...structuredClone(values));
      },
    };
    const ctx = { config: { ...config, spreadsheetId: 'mock-sheet' }, storeMode: 'sheet', sheets };
    await run(['check'], ctx);
    assert.equal(structureWrites[0].updateSheetProperties.properties.gridProperties.columnCount, HEADERS.length);
    assert.ok(structureWrites.every((r) => r.updateSheetProperties && !r.addSheet));
    assert.ok(writes.some((w) => w.range.includes('history') && w.values.some((v) => v[3] === 'watchdog')));
    assert.equal(store().pendingSync, false);
    assert.equal(store().syncError, null);
    assert.match(fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8'), /担当PC不在: 1件/);
    await run(['check'], ctx);
    assert.equal(history.filter((h) => h[3] === 'watchdog').length, 1);
    await run(['report'], ctx);
    assert.match(fs.readFileSync(path.join(dir, 'MORNING.md'), 'utf8'), /## 担当PC不在[\s\S]*T10/);
    failHistory = true;
    await run(['check'], { ...ctx, now: new Date('2026-11-29T13:00:00+09:00') });
    assert.equal(store().pendingSync, true);
    assert.match(store().syncError, /通信失敗/);
    failHistory = false;
    await run(['check'], { ...ctx, now: new Date('2026-11-29T13:15:00+09:00') });
    assert.equal(store().pendingSync, false);
    assert.equal(history.filter((h) => h[3] === 'watchdog').length, 2);
    assert.equal(mock().sent.length, 0);
  });
});

test('追加列は末尾互換・実物検証は偽完了を拒否・公開URL抽出とfile完了', async () => {
  assert.equal(HEADERS.length, FIELDS.length);
  assert.deepEqual(FIELDS.slice(31), ['requestKind', 'requestedBy', 'evidenceKind', 'evidence', 'prereq', 'kimOnlyAction', 'reassignTo', 'outcomeSource', 'outcomeMaxDays', 'lastOutcomeAt', 'lastJobResult']);
  assert.equal(valuesToRow(['old-request']).requestKind, 'human');
  assert.equal(valuesToRow(['old-request']).outcomeMaxDays, 0);
  for (const evidence of ['exit 0', 'exitCode=0', 'status=approved', 'approved']) {
    for (const kind of ['', 'tracking-number', 'public-url', 'reply-text', 'file']) assert.equal(validateEvidence(kind, evidence).ok, false);
  }
  assert.equal(validateEvidence('', '').ok, true);
  for (const url of ['', 'file:///tmp/result', 'http://example.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://192.168.1.1/a', 'https://www.instagram.com/']) {
    assert.equal(validateEvidence('public-url', url).ok, false, url);
  }
  assert.equal(validateEvidence('public-url', 'https://www.instagram.com/reel/example/').ok, true);
  assert.equal(validateEvidence('tracking-number', '123456789012345').ok, false);
  assert.equal(validateEvidence('reply-text', '短い返信').ok, false);
  await outcomeScenario('evidence', async ({ dir, add, run, store, replies }) => {
    const file = path.join(dir, 'result.txt');
    fs.writeFileSync(file, '');
    assert.equal(validateEvidence('file', file).ok, false);
    assert.equal(validateEvidence('file', dir).ok, false);
    await add('FILE', ['--kind', 'claude-code', '--evidence-kind', 'file']);
    assert.equal(await run(['complete', '--id', 'FILE', '--evidence', file]), 2);
    fs.writeFileSync(file, '実物の成果');
    assert.equal(await run(['complete', '--id', 'FILE', '--evidence', file]), 0);
    assert.equal(store().items[0].evidence, file);
    await add('URL', ['--evidence-kind', 'public-url'], { chat: 'url', donePattern: '公開' });
    replies('url', '公開しました https://www.instagram.com/p/example/');
    await run(['check']);
    assert.equal(store().items[1].status, '完了');
    assert.equal(store().items[1].evidence, 'https://www.instagram.com/p/example/');
    await add('CLI', ['--kind', 'globo']);
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'followup-ledger.mjs'), 'complete', '--store', 'local', '--id', 'CLI'], { encoding: 'utf8', env: process.env, windowsHide: true });
    assert.equal(cli.status, 2);
    assert.match(cli.stderr, /完了の実物が無い/);
    assert.equal(store().items[2].status, '依頼中');
  });
});

test('成果ソース読取: 最終投稿・承認済み件数・読めないPCのパス', () => {
  const dir = tmpDir('read-outcome');
  const now = new Date('2026-11-28T13:00:00+09:00');
  const posts = [
    { status: 'posted', postedAt: '2026-11-27T13:00:00+09:00', postUrl: 'https://www.instagram.com/p/one/' },
    { status: 'posted', postedAt: '2026-11-28T12:00:00+09:00', postUrl: 'https://www.instagram.com/reel/two/' },
    { status: 'approved', postedAt: '' },
    { status: 'draft' },
  ];
  posts.forEach((p, i) => fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(p)));
  const snapshot = readOutcome(`insta-queue:${dir}`, { now });
  assert.equal(snapshot.outcomes.length, 2);
  assert.equal(snapshot.pendingApproved, 1);
  assert.equal(snapshot.lastOutcomeAt, posts[1].postedAt);
  assert.equal(readOutcome(`json:${path.join(dir, 'missing.json')}`, { now }), null);
  assert.equal(readOutcome(`insta-queue:${path.join(dir, 'missing')}`, { now }), null);
});

test('followup-ledger-agenda: 追加列のある台帳から従来の案件別TODOを生成', async () => {
  await outcomeScenario('agenda', async ({ dir, add, run }) => {
    await add('AGENDA-AI', ['--kind', 'globo', '--prereq', `file:${path.join(dir, 'missing')}`]);
    await run(['check']);
    const output = path.join(dir, 'agenda.md');
    // mainを直接呼び、台帳の読取とMarkdown/JSON生成を検証する。
    const code = "const { main } = await import('./tools/followup-ledger-agenda.mjs'); main(['--date', '2026-11-30', '--output', process.argv[1]]);";
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, output], {
      cwd: path.dirname(__dirname), env: process.env, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(output, 'utf8'), /AGENDA-AI/);
    const agenda = JSON.parse(fs.readFileSync(path.join(dir, 'agenda.json'), 'utf8'));
    assert.equal(agenda.summary.stalled, 1);
    assert.equal(agenda.stalled[0].requestKind, 'globo');
  });
});


const HISTORY_TEST_HEADERS = ['時刻', '依頼ID', '状態', '理由', '送信ID', '実行PC', '実行AI'];
function fleetSheet() {
  const rows = [], history = [], writes = [];
  const sheets = {
    metadata: async () => ({ sheets: ['ledger', 'history'].map((title) => ({ properties: { title, gridProperties: { columnCount: HEADERS.length } } })) }),
    get: async (_id, range) => range.includes('1:') ? [range.includes('ledger') ? HEADERS : HISTORY_TEST_HEADERS]
      : structuredClone(range.includes('ledger') ? rows : history),
    update: async (_id, range, values) => {
      writes.push(range);
      const index = Number(range.match(/!A(\d+)/)[1]) - 2;
      rows[index] = structuredClone(values[0]);
    },
    append: async (_id, range, values) => {
      writes.push(range);
      (range.includes('ledger') ? rows : history).push(...structuredClone(values));
    },
  };
  return { sheets, rows, history, writes };
}
function connectorValues(id, ai, extra = {}) {
  const row = { '依頼ID': id, '依頼先': 'AI担当', 'チャネル': 'test-unsendable', '依頼内容': '成果物を記録する',
    '依頼日時': '2026/11/28 11:30', '完了条件': '成果物URLがある', '担当AI': ai, '依頼種別': 'ai', '依頼元': '金さん', ...extra };
  return HEADERS.map((h) => row[h] ?? '');
}
async function capture(fn) {
  const lines = [];
  const previous = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try { return { code: await fn(), output: lines.join('\n') }; }
  finally { console.log = previous; }
}

test('T11 別PC: 000・011・018 など別のPCで登録した1件が一覧に出て、催促の対象になる', async () => {
  await outcomeScenario('t11', async ({ run, config, mock }) => {
    const sheet = fleetSheet();
    const ctx = { config: { ...config, spreadsheetId: 'mock', hubPc: '008' }, storeMode: 'sheet', sheets: sheet.sheets };
    await withEnv({ FOLLOWUP_PC: '011' }, async () => {
      const result = await capture(() => run(addArgs('T11', { extra: ['--store', 'sheet', '--owner-pc', ''] }), ctx));
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.output).registeredFrom, '011');
      assert.equal(JSON.parse(result.output).effectiveOwnerPc, '008');
    });
    assert.equal(sheet.history[0][5], '011');
    assert.equal(valuesToRow(sheet.rows[0]).ownerPc, '');
    const status = await capture(() => run(['status', '--json'], ctx));
    assert.equal(JSON.parse(status.output)[0].id, 'T11');
    await withEnv({ FOLLOWUP_PC: '018' }, () => run(['run', '--id', 'T11'], ctx));
    assert.equal(mock().sent.length, 0);
    await withEnv({ FOLLOWUP_PC: '008' }, () => run(['run', '--id', 'T11'], ctx));
    assert.equal(mock().sent.length, 1);
    for (const name of ['', 'Grok Bot', 'fuwa', 'どっと']) assert.equal(effectiveOwnerPc({ ownerPc: name }, ctx.config), '008');
    assert.equal(effectiveOwnerPc({ ownerPc: '018' }, ctx.config), '018');
    assert.equal(effectiveOwnerPc({}, { hubPc: '000' }), '000');
  });
});

for (const [number, name, input] of [[12, 'グロボ', 'Grok Bot'], [13, 'ふわ', 'fuwa'], [14, 'どっと', 'dots']]) {
  test(`T${number} ${name}が登録した1件が一覧に出て、催促の対象になる`, async () => {
    await outcomeScenario(`t${number}`, async ({ run, config, mock }) => {
      const sheet = fleetSheet();
      sheet.rows.push(connectorValues(`T${number}`, input));
      const ctx = { config: { ...config, spreadsheetId: 'mock', hubPc: '008' }, storeMode: 'sheet', sheets: sheet.sheets };
      const listed = await capture(() => run(['status', '--json'], ctx));
      const row = JSON.parse(listed.output)[0];
      assert.equal(row.ownerAi, name);
      assert.equal(row.status, '依頼中');
      assert.equal(row.intervalMin, 15);
      assert.equal(row.renudgeMin, 60);
      assert.equal(row.maxNudges, 3);
      assert.equal(row.requestedAt, '2026-11-28T11:30:00+09:00');
      assert.equal(row.nextCheckAt, '');
      assert.equal(row.updatedAt, '');
      // Actual sends still require the existing TEMA gate; registration itself needs only nine columns.
      sheet.rows[0][FIELDS.indexOf('temaCheck')] = parseArgs(addArgs('tema')).flags['tema-check'];
      await withEnv({ FOLLOWUP_PC: '008' }, () => run(['run', '--id', row.id], ctx));
      assert.equal(mock().sent.length, 1);
      assert.equal(valuesToRow(sheet.rows[0]).status, '催促済み');
      assert.equal(sheet.history.some((h) => h[3] === 'watchdog'), false);
    });
  });
}

test('T15 必須列不足の直接追加は止まった＋ALERT', async () => {
  await outcomeScenario('t15', async ({ run, config, dir, mock }) => {
    const sheet = fleetSheet();
    sheet.rows.push(connectorValues('T15', 'Grok Bot', { '完了条件': '', '依頼元': '' }));
    sheet.rows.push(connectorValues('', 'ふわ'));
    const ctx = { config: { ...config, spreadsheetId: 'mock', hubPc: '008' }, storeMode: 'sheet', sheets: sheet.sheets };
    const row = valuesToRow(sheet.rows[0]);
    assert.equal(row.status, '止まった');
    assert.equal(row.statusReason, '必須列不足: 完了条件・依頼元');
    await withEnv({ FOLLOWUP_PC: '008' }, () => run(['run'], ctx));
    assert.match(fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8'), /必須列不足: 完了条件・依頼元/);
    assert.match(fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8'), /必須列不足: 依頼ID/);
    assert.equal(mock().sent.length, 0);
  });
});

test('T16 シートに書けない add は理由付きで exit 3・sync で反映', async () => {
  await outcomeScenario('t16', async ({ run, config, store }) => {
    const sheet = fleetSheet();
    const ctx = { config: { ...config, spreadsheetId: 'mock', hubPc: '008' }, storeMode: 'sheet', sheets: sheet.sheets };
    const append = sheet.sheets.append;
    sheet.sheets.append = async () => { throw new Error('Sheets POST HTTP 403 secret-value-must-not-leak'); };
    const result = await capture(() => run(addArgs('T16', { extra: ['--store', 'sheet', '--owner-pc', ''] }), ctx));
    assert.equal(result.code, 3);
    assert.match(result.output, /権限なし.*seisaku-team@orgiast.jp/);
    assert.doesNotMatch(result.output, /secret-value/);
    assert.equal(store().items[0]._pendingSheet, true);
    assert.equal(store().history[0]._pendingSheet, true);
    // Another read must not discard the failed add.
    await run(['status'], ctx);
    assert.equal(store().items[0]._pendingSheet, true);
    sheet.sheets.append = append;
    assert.equal(await run(['sync'], ctx), 0);
    assert.equal(sheet.rows.length, 1);
    assert.equal(sheet.history.length, 1);
    assert.equal(store().pendingSync, false);
    assert.equal(await run(['sync'], ctx), 0);
    assert.equal(sheet.rows.length, 1);
    assert.equal(sheet.history.length, 1);
    // Append committed but its response was lost: retry must retain the sheet row.
    sheet.sheets.append = async (...args) => { await append(...args); throw new Error('fetch failed'); };
    assert.equal(await run(addArgs('T16-ambiguous', { extra: ['--store', 'sheet'] }), ctx), 3);
    sheet.sheets.append = append;
    assert.equal(await run(['sync'], ctx), 0);
    assert.equal(sheet.rows.filter((v) => v[0] === 'T16-ambiguous').length, 1);
    assert.equal(sheet.history.filter((v) => v[1] === 'T16-ambiguous').length, 1);
    const missing = await capture(() => run(addArgs('T16-no-id', { extra: ['--store', 'sheet'] }), { ...ctx, config: { ...ctx.config, spreadsheetId: '' } }));
    assert.equal(missing.code, 3);
    assert.match(missing.output, /spreadsheetId 未設定/);
    assert.equal(store().items.find((r) => r.id === 'T16-no-id')._pendingSheet, true);
    const sources = { keyPath: 'missing-key.json', keyExists: false, relay: 'https://relay.invalid/api/gws', relayAvailable: false };
    assert.equal(classifySheetError(new Error('credential missing'), ctx.config, sources).category, '鍵なし');
    assert.equal(classifySheetError(new Error('HTTP 503'), ctx.config, sources).category, '通信失敗');
  });
});

test('doctor は読取専用・失敗理由を表示、run --dry-run はシートを書かない', async () => {
  await outcomeScenario('doctor', async ({ run, config, mock }) => {
    const sheet = fleetSheet();
    const ctx = { config: { ...config, spreadsheetId: 'mock', hubPc: '008' }, storeMode: 'sheet', sheets: sheet.sheets };
    assert.equal((await capture(() => run(['doctor', '--json'], ctx))).code, 0);
    assert.equal(sheet.writes.length, 0);
    sheet.rows.push(connectorValues('DRY', 'muse'));
    const before = structuredClone(sheet.rows);
    const output = await withEnv({ FOLLOWUP_PC: '008' }, () => capture(() => run(['run', '--dry-run', '--json', '--id', 'DRY'], ctx)));
    const summary = JSON.parse(output.output);
    assert.equal(summary.processRows[0].effectiveOwnerPc, '008');
    assert.equal(summary.nudges.length, 1);
    assert.equal(mock().sent.length, 0);
    assert.equal(sheet.writes.length, 0);
    assert.deepEqual(sheet.rows, before);
    sheet.sheets.get = async () => { throw new Error('HTTP 403 secret-value'); };
    const failed = await capture(() => run(['doctor', '--json'], ctx));
    assert.equal(failed.code, 3);
    assert.match(failed.output, /権限なし/);
    assert.doesNotMatch(failed.output, /secret-value/);
    assert.equal(sheet.writes.length, 0);
    for (const s of ['grok', 'grobo', 'グロボ', 'Grok Bot']) assert.equal(normalizeOwnerAi(s), 'グロボ');
    for (const s of ['fuwa', 'ふわ', 'meta muse', 'muse']) assert.equal(normalizeOwnerAi(s), 'ふわ');
    for (const s of ['dots', 'dotto', 'どっと']) assert.equal(normalizeOwnerAi(s), 'どっと');
    assert.equal(normalizeOwnerAi('Claude Code'), 'Claude Code');
  });
});


test('followup の6行は配布テンプレートとconvergeブロックに残る', async () => {
  const { build } = await import('./onboarding-sync.mjs');
  const guidance = fs.readFileSync(new URL('./claude-md-followup.md', import.meta.url), 'utf8');
  const template = fs.readFileSync(new URL('../CLAUDE.md.template', import.meta.url), 'utf8');
  const lines = guidance.trim().split(/\r?\n/);
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.ok(build('', '', 'test').updated.includes(line));
    assert.ok(template.includes(line));
  }
});
