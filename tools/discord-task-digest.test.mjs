import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  dedupeKey,
  isNearDuplicate,
  isExpiredSameDay,
  isStaleOverdue,
  mergeTasks,
  pickTop,
  preprocessForTasks,
  priorityScore,
  runDiscordTaskDigest,
  selectActiveChannels,
  snowflakeToMs,
  sortTasks,
  similarity,
  taskToRow,
  titleTokens,
} from './discord-task-digest.mjs';

function snowflake(ms, increment = 0n) {
  return String((BigInt(ms) - 1420070400000n) * 4194304n + increment);
}

const NOW = new Date('2026-09-02T03:00:00.000Z');

test('isStaleOverdue は JST で期限を7日超過した未完了タスクを判定する', () => {
  const now = new Date('2026-09-01T15:00:00Z');
  const task = { status: '未着手', deadline: '2026-08-25' };
  assert.equal(isStaleOverdue(task, { now }), true);
  assert.equal(isStaleOverdue({ ...task, deadline: '2026-08-26' }, { now }), false);
  assert.equal(isStaleOverdue({ ...task, deadline: '' }, { now }), false);
  assert.equal(isStaleOverdue({ ...task, deadline: '2026/08/25' }, { now }), false);
  assert.equal(isStaleOverdue({ ...task, deadline: '2026-02-30' }, { now }), false);
  assert.equal(isStaleOverdue({ ...task, status: '完了' }, { now }), false);
});

test('pickTop は入力順を保ち、通常枠と期限超過枠にそれぞれ上限を適用する', () => {
  const stale = { id: 'T-0001', rank: 'P1', title: '発送手配', deadline: '2026-08-25' };
  const first = { id: 'T-0002', rank: 'P2', title: '見積作成' };
  const second = { id: 'T-0003', rank: 'P1', title: '確認連絡' };
  const active = { status: '進行中' };
  const tasks = [
    { ...stale, ...active },
    { ...first, ...active },
    { ...stale, ...active, id: 'T-0004' },
    { ...second, ...active },
    { ...stale, ...active, id: 'T-0005' },
    { ...second, ...active, id: 'T-0006' },
  ];
  assert.deepEqual(pickTop(tasks, { now: NOW, limit: 2 }), {
    top: [first, second],
    staleOverdue: [stale, { ...stale, id: 'T-0004' }],
    expiredSameDay: [],
  });
});

test('isExpiredSameDay は期限が起票日以前で JST の期限日を過ぎた未完了タスクを判定する', () => {
  const now = new Date('2026-11-20T03:00:00Z');
  const born = { status: '未着手', deadline: '2026-11-19', createdAt: '2026-11-20 06:33' };
  assert.equal(isExpiredSameDay(born, { now }), true);
  const sameDay = { status: '進行中', deadline: '2026-11-18', createdAt: '2026-11-18 6:32' };
  assert.equal(isExpiredSameDay(sameDay, { now }), true);
  assert.equal(isExpiredSameDay(sameDay, { now: new Date('2026-11-18T03:00:00Z') }), false);
  assert.equal(isExpiredSameDay({ ...born, deadline: '2026-11-10', createdAt: '2026-11-05 10:00' }, { now }), false);
  assert.equal(isExpiredSameDay({ ...born, createdAt: '' }, { now }), false);
  assert.equal(isExpiredSameDay({ ...born, status: '完了' }, { now }), false);
  assert.equal(isExpiredSameDay({ ...born, deadline: '2026-11-31' }, { now }), false);
  assert.equal(isExpiredSameDay(sameDay, { now: new Date('2026-11-18T14:59:00Z') }), false);
  assert.equal(isExpiredSameDay(sameDay, { now: new Date('2026-11-18T15:00:00Z') }), true);
});

test('pickTop は通常・期限超過・当日系期限切れの3枠に分け、入力順を保つ', () => {
  const active = { status: '進行中' };
  const stale = { id: 'S-001', rank: 'P1', title: '古い期限切れ', deadline: '2026-11-10' };
  const born = { id: 'E-001', rank: 'P1', title: '当日系期限切れ', deadline: '2026-11-19' };
  const regular = { id: 'R-001', rank: 'P2', title: '通常タスク' };
  const tasks = [
    { ...born, ...active, createdAt: '2026-11-20 06:33' },
    { ...stale, ...active, createdAt: '2026-11-01 06:30' },
    { ...regular, ...active, createdAt: '2026-11-19 06:30' },
    { ...born, ...active, id: 'E-002', createdAt: '2026-11-20 06:33' },
  ];
  assert.deepEqual(pickTop(tasks, { now: new Date('2026-11-20T03:00:00Z'), limit: 3 }), {
    top: [regular],
    staleOverdue: [stale],
    expiredSameDay: [born, { ...born, id: 'E-002' }],
  });
});

test('pickTop は完了・クローズのタスクを top に入れず、アクティブなタスクだけを抽出する', () => {
  const active = { status: '進行中' };
  const done = { status: '完了' };
  const closed = { status: 'クローズ' };
  const tasks = [
    { id: 'T-0001', rank: 'P1', title: '完了タスク', ...done },
    { id: 'T-0002', rank: 'P2', title: 'アクティブ', ...active },
    { id: 'T-0003', rank: 'P1', title: 'クローズタスク', ...closed },
    { id: 'T-0004', rank: 'P3', title: 'アクティブその2', ...active },
  ];
  assert.deepEqual(pickTop(tasks, { now: NOW, limit: 5 }), {
    top: [
      { id: 'T-0002', rank: 'P2', title: 'アクティブ' },
      { id: 'T-0004', rank: 'P3', title: 'アクティブその2' },
    ],
    staleOverdue: [],
    expiredSameDay: [],
  });
});

test('snowflakeToMs は既知の snowflake を時刻に変換する', () => {
  assert.equal(snowflakeToMs('175928847299117063'), 1462015105796);
  assert.equal(snowflakeToMs(snowflake(NOW.getTime(), 123n)), NOW.getTime());
});

test('selectActiveChannels は古いチャンネルを取得対象から除外する', () => {
  const since = NOW.getTime() - 864e5;
  const channels = [
    { id: 'new', type: 0, last_message_id: snowflake(NOW.getTime()) },
    { id: 'old', type: 0, last_message_id: snowflake(since - 1) },
    { id: 'voice', type: 2, last_message_id: snowflake(NOW.getTime()) },
    { id: 'none', type: 5, last_message_id: null },
  ];
  assert.deepEqual(selectActiveChannels(channels, since).map((x) => x.id), ['new']);
});

test('preprocessForTasks は bot、あいさつ、短文、画像のみ、重複を落とす', () => {
  const text = '請求書の支払期限が9月3日なので、今日中に確認をお願いします。';
  const messages = [
    { id: '1', content: '了解しました', author: {} },
    { id: '2', content: '確認します', author: {} },
    { id: '3', content: '', attachments: [{ id: 'a' }], author: {} },
    { id: '4', content: text, author: {} },
    { id: '5', content: `  ${text}  `, author: {} },
    { id: '6', content: 'これは十分に長いbotからの自動投稿メッセージです。', author: { bot: true } },
    { id: '7', content: '期限は9/3', author: {} },
  ];
  assert.deepEqual(preprocessForTasks(messages).map((x) => x.id), ['4', '7']);
});

test('priorityScore は期限境界と空期限を正しく加点する', () => {
  const base = { urgency: 0, impact: 0, type: 'タスク', title: '', action: '', channelName: '' };
  assert.equal(priorityScore({ ...base, deadline: '2026-09-02' }, { now: NOW }), 20);
  assert.equal(priorityScore({ ...base, deadline: '2026-09-05' }, { now: NOW }), 14);
  assert.equal(priorityScore({ ...base, deadline: '2026-09-10' }, { now: NOW }), 4);
  assert.equal(priorityScore({ ...base, deadline: '' }, { now: NOW }), 0);
});

test('priorityScore は KPI を重複加点せず100で clampする', () => {
  const kpi = { urgency: 0, impact: 0, type: 'タスク', title: '請求と顧客案件の改善', action: '入金と施工を確認', channelName: '売上' };
  assert.equal(priorityScore(kpi, { now: NOW }), 8);
  assert.equal(priorityScore({ ...kpi, urgency: 3, impact: 3, type: 'リスク', deadline: '2026-09-02' }, { now: NOW }), 100);
});

test('sortTasks は未完了、スコア、期限、IDの順に並べる', () => {
  const tasks = [
    { id: 'T-0005', status: '完了', score: 100, deadline: '2026-09-01' },
    { id: 'T-0004', status: '未着手', score: 50, deadline: '' },
    { id: 'T-0003', status: '進行中', score: 60, deadline: '2026-09-10' },
    { id: 'T-0002', status: '保留', score: 60, deadline: '2026-09-03' },
    { id: 'T-0001', status: '保留', score: 60, deadline: '2026-09-03' },
  ];
  assert.deepEqual(sortTasks(tasks).map((x) => x.id), ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005']);
});

function item(overrides = {}) {
  return { channelId: '10', channelName: '経理', title: '請求書を確認する', action: '担当者が請求書を確認する', type: 'タスク', owner: '', deadline: '', urgency: 1, impact: 1, evidence: '請求書を確認してください', link: 'https://discord.com/channels/1/10/99', ...overrides };
}

function existingRow(status = '未着手', memo = '手入力メモ') {
  return ['T-0001', '2026-09-01 10:00', 'P2', 50, 'タスク', '請求書を確認する', '以前のアクション', '', '', '経理', '根拠', 'https://discord.com/channels/1/10/88', status, memo, '2026-09-01 10:00'];
}

test('dedupeKey は正規化し、未完了との衝突だけ追加を止める', () => {
  assert.equal(dedupeKey(item()), dedupeKey(item({ title: ' 請求書を確認する　' })));
  assert.equal(mergeTasks([existingRow('未着手')], [item()], { now: NOW }).added.length, 0);
  assert.equal(mergeTasks([existingRow('完了')], [item()], { now: NOW }).added.length, 1);
});

test('titleTokens は助詞と定型語を落として2-gram集合を作る', () => {
  assert.deepEqual([...titleTokens('ＡＢ の 確認依頼')], ['ab']);
  assert.deepEqual([...titleTokens('依頼')], []);
});

test('similarity は同義表記を近似重複とし、別タスクを区別する', () => {
  assert.ok(similarity('保管用コンテナの交換依頼', '保管用コンテナ交換の依頼') >= 0.72);
  assert.ok(similarity('カプセル傘棚卸テスト実施', 'カプセル傘在庫情報提供依頼') < 0.72);
});

test('isNearDuplicate は別チャンネルの同義タイトルを別件として扱う', () => {
  assert.equal(isNearDuplicate(item({ channelId: '10', title: '保管用コンテナの交換依頼' }), item({ channelId: '11', title: '保管用コンテナ交換の依頼' })), false);
});

test('mergeTasks は同一実行内の近似重複からスコアが高い候補を残す', () => {
  const low = item({ title: '保管用コンテナの交換依頼', urgency: 1, impact: 1, action: '交換する' });
  const high = item({ title: '保管用コンテナ交換の依頼', urgency: 3, impact: 2, action: '担当者が交換する' });
  const result = mergeTasks([], [low, high], { now: NOW });
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].title, high.title);
  assert.equal(result.suppressed, 1);
});

test('mergeTasks は既存の未完了行との近似重複を追加しない', () => {
  const row = existingRow('保留');
  row[5] = '保管用コンテナの交換依頼';
  const result = mergeTasks([row], [item({ title: '保管用コンテナ交換の依頼' })], { now: NOW });
  assert.equal(result.added.length, 0);
  assert.equal(result.suppressed, 1);
});

test('mergeTasks は既存行の状態と実行メモを保持する', () => {
  const result = mergeTasks([existingRow('進行中', 'kimの手入力')], [], { now: NOW });
  assert.equal(result.tasks[0].status, '進行中');
  assert.equal(result.tasks[0].memo, 'kimの手入力');
  assert.equal(result.tasks[0].score, 50);
  assert.equal(result.tasks[0].rank, 'P2');
  assert.deepEqual(taskToRow(result.tasks[0]).slice(12, 14), ['進行中', 'kimの手入力']);
});

test('fixture + dry-run + スタブLLMで行を組み立てる', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-task-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const channel = { id: '20', name: '営業', type: 0, last_message_id: snowflake(NOW.getTime()) };
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ channels: [channel], messages: { 20: [{ id: '200', timestamp: NOW.toISOString(), content: '顧客向け見積を9月3日までに確認して承認してください。', author: { username: '田中' } }] } }));
  const logs = [];
  const llm = async () => ({ text: JSON.stringify({ items: [{ i: 0, type: '締切', title: '顧客見積の承認', action: '担当者が顧客向け見積を確認して承認する', owner: '', deadline: '2026-09-03', urgency: 3, impact: 3, evidence: '顧客向け見積を9月3日までに確認して承認してください。' }] }) });
  const result = await runDiscordTaskDigest({ args: ['--fixture', fixture, '--dry-run'], now: NOW, home: dir, llm, existingRows: [], log: (line) => logs.push(line) });
  assert.equal(result.added, 1);
  assert.equal(result.top[0].id, 'T-0001');
  assert.equal(result.top[0].rank, 'P1');
  const output = JSON.parse(logs[0]);
  assert.equal(output.rows[0][5], '顧客見積の承認');
  assert.equal(output.rows[0][12], '未着手');
});
