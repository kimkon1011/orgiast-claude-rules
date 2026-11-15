import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCalendarFreeSlots, parseArgs } from './calendar-free-slots.mjs';

const FIXTURE_FILE = fileURLToPath(new URL('./test-fixtures/calendar-free-slots.json', import.meta.url));

function fixtureOpts(overrides) {
  return {
    from: '2026-11-10', to: '2026-11-15', mode: 'online', region: '大阪',
    start: '09:00', end: '18:00', slot: 30, min: 30,
    calendars: ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'],
    json: false, fixture: FIXTURE_FILE, weekends: false,
    ...overrides,
  };
}

// 簡単なfixture生成（テストごとに作れる）
function makeFixture(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-test-'));
  const f = path.join(dir, 'fixture.json');
  fs.writeFileSync(f, JSON.stringify(events));
  return { path: f, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('【調整可】イベントはブロックしない', async () => {
  const fix = makeFixture([
    { id: 'a', summary: '打ち合わせ【調整可】', start: { dateTime: '2026-11-10T12:00:00+09:00' }, end: { dateTime: '2026-11-10T13:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    assert.match(result, /11月10日/);
    assert.match(result, /09:00〜18:00/); // 全日空いているはず
  } finally { fix.cleanup(); }
});

test('G: バッファ（前後1時間）が効く', async () => {
  const fix = makeFixture([
    { id: 'g', summary: 'G: 訪問先', start: { dateTime: '2026-11-10T14:00:00+09:00' }, end: { dateTime: '2026-11-10T15:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    assert.match(result, /11月10日/);
    const lines = result.split('\n');
    const dayLine = lines.find(l => l.startsWith('11月10日'));
    // 13:00-16:00がブロックされているので、09:00-13:00, 16:00-18:00が空き
    assert.ok(dayLine.includes('09:00〜13:00'), `expected 09:00-13:00 free, got: ${dayLine}`);
    assert.ok(dayLine.includes('16:00〜18:00'), `expected 16:00-18:00 free, got: ${dayLine}`);
  } finally { fix.cleanup(); }
});

test('和集合: 両方のカレンダーの予定で埋まる', async () => {
  const fix = makeFixture([
    { id: 'k', summary: 'kim会議', start: { dateTime: '2026-11-10T10:00:00+09:00' }, end: { dateTime: '2026-11-10T11:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
    { id: 's', summary: 'チーム会議', start: { dateTime: '2026-11-10T11:00:00+09:00' }, end: { dateTime: '2026-11-10T12:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'seisaku-team@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    const lines = result.split('\n');
    const dayLine = lines.find(l => l.startsWith('11月10日'));
    assert.ok(dayLine.includes('09:00〜10:00'), `expected 09:00-10:00 free, got: ${dayLine}`);
    assert.ok(dayLine.includes('12:00〜18:00'), `expected 12:00-18:00 free, got: ${dayLine}`);
  } finally { fix.cleanup(); }
});

test('重複除去: 同じ開始・終了・タイトルは1件扱い', async () => {
  // 同一イベントが両方のカレンダーに出現
  const fix = makeFixture([
    { id: 'k1', summary: '全社mtg', start: { dateTime: '2026-11-10T09:00:00+09:00' }, end: { dateTime: '2026-11-10T10:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
    { id: 's1', summary: '全社mtg', start: { dateTime: '2026-11-10T09:00:00+09:00' }, end: { dateTime: '2026-11-10T10:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'seisaku-team@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    const lines = result.split('\n');
    const dayLine = lines.find(l => l.startsWith('11月10日'));
    assert.ok(dayLine.includes('10:00〜18:00'), `expected 10:00-18:00 (single block), got: ${dayLine}`);
  } finally { fix.cleanup(); }
});

test('終日地域判定: kim の全日「東京出張」で東京', async () => {
  const fix = makeFixture([
    { id: 'ad', summary: '東京出張', start: { date: '2026-11-11' }, end: { date: '2026-11-12' }, transparency: 'opaque', attendees: [], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    assert.match(result, /※東京/);
    // 11-11 should show ※東京
    const lines = result.split('\n');
    const tokyoLine = lines.find(l => l.includes('東京') && l.includes('11月11日'));
    assert.ok(tokyoLine, 'expected Tokyo annotation on 11-11');
  } finally { fix.cleanup(); }
});

test('終日地域判定: kim 以外の全日は地域に使わない', async () => {
  const fix = makeFixture([
    { id: 'ad', summary: '東京（seisaku-team）', start: { date: '2026-11-11' }, end: { date: '2026-11-12' }, transparency: 'opaque', attendees: [], _source: 'seisaku-team@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    // seisaku-team の終日は地域に使わないため大阪のまま
    const lines = result.split('\n');
    const dayLine = lines.find(l => l.startsWith('11月11日'));
    assert.ok(dayLine, '11-11 should exist');
    assert.doesNotMatch(dayLine, /東京/);
  } finally { fix.cleanup(); }
});

test('declined はブロックしない', async () => {
  const fix = makeFixture([
    { id: 'd', summary: '辞退した打ち合わせ', start: { dateTime: '2026-11-10T10:00:00+09:00' }, end: { dateTime: '2026-11-10T12:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'declined' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    // declined なので全日空いている
    assert.match(result, /11月10日.*09:00〜18:00/);
  } finally { fix.cleanup(); }
});

test('transparent はブロックしない', async () => {
  const fix = makeFixture([
    { id: 't', summary: '自由参加', start: { dateTime: '2026-11-10T10:00:00+09:00' }, end: { dateTime: '2026-11-10T12:00:00+09:00' }, transparency: 'transparent', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    assert.match(result, /11月10日.*09:00〜18:00/);
  } finally { fix.cleanup(); }
});

test('offline モード: 大阪指定時の東京出張前後1日ブロック', async () => {
  const fix = makeFixture([
    { id: 'ad', summary: '東京出張', start: { date: '2026-11-11' }, end: { date: '2026-11-14' }, transparency: 'opaque', attendees: [], _source: 'kim@orgiast.jp' },
    { id: 'm', summary: '社内mtg', start: { dateTime: '2026-11-10T14:00:00+09:00' }, end: { dateTime: '2026-11-10T15:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ mode: 'offline', region: '大阪', fixture: fix.path }));
    // 東京出張 11/11-11/13（終日、end 11/14 は排他的）
    // → buffer: 11/10(前日), 11/11(当日), 11/12(翌日), 11/13(最終日翌日扱い)
    // → 地域=東京の日: 11/11,11/12,11/13
    // → 大阪の日なし
    assert.match(result, /（該当する空き時間なし）/);
  } finally { fix.cleanup(); }
});

test('休暇（有給）の日はスキップ', async () => {
  const fix = makeFixture([
    { id: 'hol', summary: '有給休暇', start: { date: '2026-11-11' }, end: { date: '2026-11-12' }, transparency: 'opaque', attendees: [], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    const lines = result.split('\n');
    // 11-11 は休暇でスキップされているはず
    assert.ok(!lines.some(l => l.startsWith('11月11日')), '11-11 should be skipped for holiday');
  } finally { fix.cleanup(); }
});

test('休暇判定: 地域名のみの終日はブロックしない', async () => {
  const fix = makeFixture([
    { id: 'r', summary: '東京', start: { date: '2026-11-11' }, end: { date: '2026-11-12' }, transparency: 'opaque', attendees: [], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    // 「東京」だけの終日: 地域名のみなので休暇扱いしない。全日空いている
    assert.match(result, /11月11日.*09:00〜18:00/);
  } finally { fix.cleanup(); }
});

test('ページング: 多数イベントの処理', async () => {
  // 大量イベントでも正しく処理できることを確認
  const events = [];
  const sources = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
  for (let d = 0; d < 6; d++) {
    for (let i = 0; i < 50; i++) {
      const h = 9 + (i % 9);
      const date = `2026-11-${String(10 + d).padStart(2, '0')}`;
      events.push({
        id: `d${d}-i${i}`, summary: `イベント d${d}-${i}`,
        start: { dateTime: `${date}T${String(h).padStart(2, '0')}:${String(i * 2 % 60).padStart(2, '0')}:00+09:00` },
        end: { dateTime: `${date}T${String(h + 1).padStart(2, '0')}:${String(i * 2 % 60).padStart(2, '0')}:00+09:00` },
        transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }],
        _source: sources[i % 2],
      });
    }
  }
  const fix = makeFixture(events);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path, to: '2026-11-16' }));
    assert.ok(result.length > 0);
  } finally { fix.cleanup(); }
});

test('--json 出力が正しい構造を持つ', async () => {
  const fix = makeFixture([
    { id: 'm', summary: '会議', start: { dateTime: '2026-11-10T10:00:00+09:00' }, end: { dateTime: '2026-11-10T11:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path, json: true }));
    assert.ok(result.generatedAt !== undefined);
    assert.equal(result.mode, 'online');
    assert.equal(result.region, null);
    assert.ok(Array.isArray(result.days));
    assert.ok(result.days.length > 0);
    assert.ok(result.days[0].date !== undefined);
    assert.ok(result.days[0].weekday !== undefined);
    assert.ok(result.days[0].slots !== undefined);
    assert.ok(Array.isArray(result.days[0].slots));
  } finally { fix.cleanup(); }
});

test('parseArgs: 既定値が正しい', () => {
  const args = parseArgs([]);
  assert.equal(args.mode, 'online');
  assert.equal(args.region, '大阪');
  assert.equal(args.start, '09:00');
  assert.equal(args.end, '18:00');
  assert.equal(args.slot, 30);
  assert.equal(args.min, 30);
  assert.equal(args.json, false);
  assert.equal(args.weekends, false);
  assert.deepEqual(args.calendars, ['kim@orgiast.jp', 'seisaku-team@orgiast.jp']);
  assert.ok(args.from !== undefined);
  assert.ok(args.to !== undefined);
});

test('parseArgs: 明示的な引数', () => {
  const args = parseArgs(['--from', '2026-12-01', '--to', '2026-12-07', '--mode', 'offline', '--region', '東京', '--json', '--weekends']);
  assert.equal(args.from, '2026-12-01');
  assert.equal(args.to, '2026-12-07');
  assert.equal(args.mode, 'offline');
  assert.equal(args.region, '東京');
  assert.equal(args.json, true);
  assert.equal(args.weekends, true);
});

test('--weekends 付きで土日を含める', async () => {
  const fix = makeFixture([
    { id: 'm', summary: '会議', start: { dateTime: '2026-11-10T10:00:00+09:00' }, end: { dateTime: '2026-11-10T11:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path, weekends: true, to: '2026-11-16' }));
    // 11-14(土)と11-15(日)が出ているはず
    const lines = result.split('\n');
    assert.ok(lines.some(l => l.startsWith('11月14日')), 'Saturday should be included with --weekends');
    assert.ok(lines.some(l => l.startsWith('11月15日')), 'Sunday should be included with --weekends');
  } finally { fix.cleanup(); }
});

test('--min で指定した分数以上の連続空きだけ出す', async () => {
  const fix = makeFixture([
    { id: 'm1', summary: '午前中', start: { dateTime: '2026-11-10T09:00:00+09:00' }, end: { dateTime: '2026-11-10T10:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
    { id: 'm2', summary: '昼から', start: { dateTime: '2026-11-10T11:00:00+09:00' }, end: { dateTime: '2026-11-10T17:30:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    // min=60 で 60分以上の連続空きだけ
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path, min: 60 }));
    const lines = result.split('\n');
    const dayLine = lines.find(l => l.startsWith('11月10日'));
    // 10:00-11:00 は 60分だが、会議が 10:00までと11:00からで間の 10:00-11:00が60分ある → 出るはず
    // 17:30-18:00 は 30分 < 60分 → 出ない
    assert.ok(dayLine.includes('10:00'), '10:00-11:00 should appear (60min >= 60min)');
    assert.ok(!dayLine.includes('17:30'), '17:30-18:00 should NOT appear (30min < 60min)');
  } finally { fix.cleanup(); }
});

test('同日同タイトルの別時間帯イベントは両方ブロックする', async () => {
  const fix = makeFixture([
    { id: 'm1', summary: '打ち合わせ', start: { dateTime: '2026-11-10T10:00:00+09:00' }, end: { dateTime: '2026-11-10T11:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
    { id: 'm2', summary: '打ち合わせ', start: { dateTime: '2026-11-10T14:00:00+09:00' }, end: { dateTime: '2026-11-10T15:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    const lines = result.split('\n');
    const dayLine = lines.find(l => l.startsWith('11月10日'));
    // 10:00-11:00 と 14:00-15:00 の両方がブロックされ、09:00-10:00, 11:00-14:00, 15:00-18:00 が空き
    assert.ok(dayLine.includes('09:00〜10:00'), `expected 09:00-10:00 free, got: ${dayLine}`);
    assert.ok(dayLine.includes('11:00〜14:00'), `expected 11:00-14:00 free, got: ${dayLine}`);
    assert.ok(dayLine.includes('15:00〜18:00'), `expected 15:00-18:00 free, got: ${dayLine}`);
  } finally { fix.cleanup(); }
});

test('Bug1: 大阪オフラインで東京のみ終日の前日・翌日が候補から外れる', async () => {
  const fix = makeFixture([
    { id: 'trip', summary: '東京', start: { date: '2026-11-10' }, end: { date: '2026-11-12' }, transparency: 'opaque', attendees: [], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots({
      from: '2026-11-09', to: '2026-11-13', mode: 'offline', region: '大阪',
      start: '09:00', end: '18:00', slot: 30, min: 30,
      calendars: ['kim@orgiast.jp'], json: false, fixture: fix.path, weekends: false,
    });
    // 東京 on 11/10-11/11 → 11/09(前日)・11/12(翌日)は大阪だがバッファなので除外
    // 11/13 は大阪で出張なし→候補に出る
    const lines = result.split('\n');
    assert.ok(!lines.some(l => l.startsWith('11月9日')), '11/09 should be excluded (buffer before Tokyo)');
    assert.ok(!lines.some(l => l.startsWith('11月12日')), '11/12 should be excluded (buffer after Tokyo)');
    assert.ok(lines.some(l => l.startsWith('11月13日')), '11/13 should appear (free day)');
  } finally { fix.cleanup(); }
});

test('Bug1: 地域名のみの終日「東京」でもバッファ日が除外される（online は影響なし）', async () => {
  // online モードではバッファは効かないことを確認
  const fix = makeFixture([
    { id: 'trip', summary: '東京', start: { date: '2026-11-10' }, end: { date: '2026-11-12' }, transparency: 'opaque', attendees: [], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots({
      from: '2026-11-09', to: '2026-11-13', mode: 'online',
      start: '09:00', end: '18:00', slot: 30, min: 30,
      calendars: ['kim@orgiast.jp'], json: false, fixture: fix.path, weekends: false,
    });
    // online は地域フィルタもバッファも効かない→全日候補に出る
    // 11/09(大阪), 11/10(東京), 11/11(東京), 11/12(大阪), 11/13(大阪) すべて
    const lines = result.split('\n');
    assert.ok(lines.some(l => l.startsWith('11月9日')), 'online: 11/09 should appear');
    assert.ok(lines.some(l => l.startsWith('11月13日')), 'online: 11/13 should appear');
  } finally { fix.cleanup(); }
});

test('Bug2: テキスト出力が「X月Y日(曜) HH:MM〜HH:MM　※地域名」形式', async () => {
  const fix = makeFixture([
    { id: 'm', summary: '会議', start: { dateTime: '2026-11-10T10:00:00+09:00' }, end: { dateTime: '2026-11-10T11:00:00+09:00' }, transparency: 'opaque', attendees: [{ self: true, responseStatus: 'accepted' }], _source: 'kim@orgiast.jp' },
  ]);
  try {
    const result = await runCalendarFreeSlots(fixtureOpts({ fixture: fix.path }));
    // 出力例: 11月10日(火) 09:00〜10:00、11:00〜18:00　※大阪
    assert.match(result, /11月10日\(火\)/);
    assert.match(result, /　※大阪/);
    assert.doesNotMatch(result, /11-10\(火\)/);
  } finally { fix.cleanup(); }
});