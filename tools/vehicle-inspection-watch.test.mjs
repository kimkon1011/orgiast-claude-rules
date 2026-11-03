import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HEADERS, STAGES, parseArgs, jstDate, parseSheetDate, daysUntil, decideNotification,
  columnLetter, parseRows, notificationBody, missingNextExpiryBody, loadState, saveState, main,
} from './vehicle-inspection-watch.mjs';

const DAY = 86_400_000;
const serial = (iso) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / DAY;

const base = {
  車両ID: 'V001', 車名: 'ベンツ V220d', 登録番号: 'なにわ330な7783', 会社: 'オルギアスト',
  管理担当: '田中', 保管場所: '本社', 車検満了日: '2026-10-27', 車検証: '', 状態: '未手配',
  依頼先: '', 入庫予定日: '', 次回満了日: '', 最終通知日: '', 通知回数: 0, 備考: '',
};
const row = (over = {}, header = HEADERS) => header.map((name) => (name in over ? over[name] : base[name]));

function makeSheet(rows) {
  const grid = rows.map((values) => [...values]);
  const updates = [];
  const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  return {
    grid,
    updates,
    async get() { return grid.map((values) => [...values]); },
    async update(id, range, values) {
      updates.push({ id, range, values });
      const match = range.match(/!([A-Z]+)(\d+)$/);
      const column = colIndex(match[1]);
      const index = Number(match[2]) - 1;
      while (grid.length <= index) grid.push([]);
      grid[index][column] = values[0][0];
    },
  };
}

function fixture(t, { rows, config = { sheetId: 'SHEET123', tab: '車検台帳' }, state } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vehicle-inspection-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'vehicle-inspection');
  fs.mkdirSync(dir, { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const sheet = makeSheet(rows);
  const kim = [];
  const staff = [];
  const out = [];
  const err = [];
  const deps = {
    home,
    sheets: sheet,
    notifyKim: async (input) => { kim.push(input); },
    notifyStaff: async (input) => { staff.push(input); },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => new Date('2026-11-03T00:00:00Z'),
  };
  return {
    home, dir, sheet, kim, staff, out, err, deps,
    stateFile: path.join(dir, 'state.json'),
    run: (args = []) => main(args, deps),
    state: () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')),
  };
}

const cellOf = (grid, header, name, rowIndex = 1) => grid[rowIndex][header.indexOf(name)];

test('引数・JST日付・日付パース', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, json: false, now: null });
  assert.deepEqual(parseArgs(['--dry-run', '--json', '--now', '2026-11-03']), { dryRun: true, json: true, now: '2026-11-03' });
  assert.throws(() => parseArgs(['--now', '2026/11/03']));
  assert.throws(() => parseArgs(['--now']));
  assert.throws(() => parseArgs(['--unknown']));

  assert.equal(jstDate(new Date('2026-11-02T15:00:00Z')), '2026-11-03');
  assert.equal(jstDate(new Date('2026-11-02T14:59:00Z')), '2026-11-02');

  assert.equal(parseSheetDate('2026-10-27'), '2026-10-27');
  assert.equal(parseSheetDate('2026/1/5'), '2026-01-05');
  assert.equal(parseSheetDate(serial('2026-10-27')), '2026-10-27');
  assert.equal(parseSheetDate(serial('2026-10-27') + 0.75), '2026-10-27');
  assert.equal(parseSheetDate(''), null);
  assert.equal(parseSheetDate('未定'), null);
  assert.equal(parseSheetDate('2026-02-30'), null);
  assert.equal(parseSheetDate(0), null);

  assert.equal(daysUntil('2026-11-03', '2026-10-27'), -7);
  assert.equal(daysUntil('2026-11-03', '2026-11-03'), 0);
  assert.equal(daysUntil('2026-11-03', '2027-02-01'), 90);
});

test('段階日・超過・予約済の間引き・未手配の30日以内は毎日', () => {
  for (const days of STAGES) {
    assert.equal(decideNotification({ remainingDays: days, status: '未手配' }).notify, true, `未手配 ${days}`);
    if (days <= 30) {
      assert.equal(decideNotification({ remainingDays: days, status: '予約済' }).notify, [14, 3, 0].includes(days), `予約済 ${days}`);
    }
  }
  for (const days of [89, 61, 46, 31]) {
    assert.equal(decideNotification({ remainingDays: days, status: '未手配' }).notify, false, `未手配 ${days}`);
    assert.equal(decideNotification({ remainingDays: days, status: '予約済' }).notify, false, `予約済 ${days}`);
  }
  for (const days of [29, 20, 13, 6, 2]) {
    assert.equal(decideNotification({ remainingDays: days, status: '未手配' }).notify, true, `未手配 ${days}`);
    assert.equal(decideNotification({ remainingDays: days, status: '見積依頼中' }).notify, true, `見積依頼中 ${days}`);
    assert.equal(decideNotification({ remainingDays: days, status: '予約済' }).notify, false, `予約済 ${days}`);
    assert.equal(decideNotification({ remainingDays: days, status: '入庫中' }).notify, false, `入庫中 ${days}`);
  }
  for (const days of [90, 60, 45]) {
    assert.equal(decideNotification({ remainingDays: days, status: '予約済' }).notify, true, `予約済 ${days}`);
  }
  for (const days of [-1, -7, -30]) {
    for (const status of ['未手配', '見積依頼中', '予約済', '入庫中']) {
      assert.equal(decideNotification({ remainingDays: days, status }).notify, true, `${status} ${days}`);
    }
  }
});

test('通知本文は状態に応じた次の一手と台帳URLを含む', () => {
  const parsed = { name: 'ベンツ V220d', plate: 'なにわ330な7783', status: '未手配', vendor: '', scheduled: '', expiry: '2026-10-27' };
  const body = notificationBody({ row: parsed, remainingDays: -7, sheetId: 'SHEET123' });
  assert.match(body, /^【車検】ベンツ V220d（なにわ330な7783）満了 2026-10-27（7日超過）/);
  assert.match(body, /状態: 未手配 ／ 依頼先: 未定 ／ 入庫予定: 未定/);
  assert.match(body, /次の一手: 公道走行不可。積載車か仮ナンバーの手配が必要/);
  assert.match(body, /https:\/\/docs\.google\.com\/a\/orgiast\.jp\/spreadsheets\/d\/SHEET123\/edit/);

  const booked = notificationBody({ row: { ...parsed, status: '予約済', vendor: '整備A', scheduled: '2026-11-10' }, remainingDays: 3, sheetId: 'S' });
  assert.match(booked, /あと3日/);
  assert.match(booked, /依頼先: 整備A ／ 入庫予定: 2026-11-10/);
  assert.match(booked, /次の一手: 入庫日を忘れずに/);

  assert.match(notificationBody({ row: { ...parsed, status: '見積依頼中' }, remainingDays: 20, sheetId: 'S' }), /見積の返信を確認/);
  assert.match(missingNextExpiryBody({ name: 'ベンツ', plate: 'P' }, 'S'), /新しい車検証の満了日が台帳に入っていません/);
});

test('見出しの並びを入れ替えても列を引ける', () => {
  const header = [...HEADERS].reverse();
  const rows = parseRows([header, row({ 車両ID: 'V009', 車名: 'ハイエース', 車検満了日: serial('2026-11-10') }, header)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'V009');
  assert.equal(rows[0].name, 'ハイエース');
  assert.equal(rows[0].expiry, '2026-11-10');
  assert.equal(rows[0].rowNumber, 2);
  assert.throws(() => parseRows([['車両ID', '車名']]), /見出しが足りません/);
});

test('段階通知を送り、台帳と state を書き戻す', async (t) => {
  const f = fixture(t, { rows: [HEADERS, row({ 車検満了日: '2026-11-10' })] });
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 1);
  assert.equal(f.kim[0].kind, 'ask');
  assert.match(f.kim[0].body, /あと7日/);
  assert.equal(f.staff.length, 1);
  assert.equal(f.staff[0].assignee, '田中');
  assert.equal(cellOf(f.sheet.grid, HEADERS, '最終通知日'), '2026-11-03');
  assert.equal(cellOf(f.sheet.grid, HEADERS, '通知回数'), 1);
  assert.deepEqual(f.state().V001, { lastNotifiedDate: '2026-11-03', lastStage: 7 });
});

test('同じ車両・同じ日は2回送らない', async (t) => {
  const f = fixture(t, { rows: [HEADERS, row({ 車検満了日: '2026-11-10' })] });
  assert.equal(await f.run(), 0);
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 1);
  assert.equal(cellOf(f.sheet.grid, HEADERS, '通知回数'), 1);
  f.deps.now = () => new Date('2026-11-04T00:00:00Z');
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 2);
  assert.equal(cellOf(f.sheet.grid, HEADERS, '通知回数'), 2);
});

test('売却済と車両ID空はスキップする', async (t) => {
  const f = fixture(t, {
    rows: [
      HEADERS,
      row({ 車両ID: 'V001', 状態: '売却済', 車検満了日: '2026-11-03' }),
      row({ 車両ID: '', 状態: '未手配', 車検満了日: '2026-11-03' }),
      row({ 車両ID: 'V003', 状態: '未手配', 車検満了日: '2026-11-03' }),
    ],
  });
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 1);
  assert.match(f.kim[0].body, /V003|ベンツ/);
  assert.equal(f.sheet.updates.filter((u) => u.range.includes('M3')).length, 0);
});

test('シリアル値の日付でも判定できる', async (t) => {
  const f = fixture(t, { rows: [HEADERS, row({ 車検満了日: serial('2026-11-03') })] });
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 1);
  assert.match(f.kim[0].body, /満了 2026-11-03（あと0日）/);
});

test('完了＋次回満了日ありは繰り上げて info を1回だけ出す', async (t) => {
  const f = fixture(t, {
    rows: [HEADERS, row({ 状態: '完了', 車検満了日: '2026-10-27', 次回満了日: '2027-10-27', 依頼先: '整備A', 入庫予定日: '2026-10-20' })],
  });
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 1);
  assert.equal(f.kim[0].kind, 'info');
  assert.match(f.kim[0].body, /次の満了日 2027-10-27/);
  assert.equal(cellOf(f.sheet.grid, HEADERS, '車検満了日'), '2027-10-27');
  assert.equal(cellOf(f.sheet.grid, HEADERS, '次回満了日'), '');
  assert.equal(cellOf(f.sheet.grid, HEADERS, '状態'), '未手配');
  assert.equal(cellOf(f.sheet.grid, HEADERS, '依頼先'), '');
  assert.equal(cellOf(f.sheet.grid, HEADERS, '入庫予定日'), '');

  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 1);
});

test('完了＋次回満了日なしは毎日 ask する', async (t) => {
  const f = fixture(t, { rows: [HEADERS, row({ 状態: '完了', 次回満了日: '' })] });
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 1);
  assert.equal(f.kim[0].kind, 'ask');
  assert.match(f.kim[0].body, /新しい車検証の満了日が台帳に入っていません/);
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 1);
  f.deps.now = () => new Date('2026-11-04T00:00:00Z');
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 2);
});

test('--dry-run は通知・書き戻し・state 更新をしない', async (t) => {
  const f = fixture(t, { rows: [HEADERS, row({ 車検満了日: '2026-11-10' })] });
  assert.equal(await f.run(['--dry-run']), 0);
  assert.equal(f.kim.length, 0);
  assert.equal(f.staff.length, 0);
  assert.equal(f.sheet.updates.length, 0);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.match(f.out.join('\n'), /dry-run/);
  assert.match(f.out.join('\n'), /\[notify\] V001/);
});

test('--json は判定を JSON で返す', async (t) => {
  const f = fixture(t, { rows: [HEADERS, row({ 車検満了日: '2026-11-10' })] });
  assert.equal(await f.run(['--json', '--dry-run']), 0);
  const parsed = JSON.parse(f.out.join('\n'));
  assert.equal(parsed.today, '2026-11-03');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.decisions[0].action, 'notify');
  assert.equal(parsed.decisions[0].remainingDays, 7);
});

test('設定が無い・sheetId が無いときは exit 2', async (t) => {
  const missing = fixture(t, { rows: [HEADERS], config: null });
  assert.equal(await missing.run(), 2);
  assert.match(missing.err.join('\n'), /設定なし/);

  const empty = fixture(t, { rows: [HEADERS], config: { tab: '車検台帳' } });
  assert.equal(await empty.run(), 2);
  assert.match(empty.err.join('\n'), /sheetId/);
});

test('管理担当が空なら staff 送信を飛ばし、失敗しても kim 通知と書き戻しは続く', async (t) => {
  const f = fixture(t, { rows: [HEADERS, row({ 車検満了日: '2026-11-10', 管理担当: '' })] });
  assert.equal(await f.run(), 0);
  assert.equal(f.kim.length, 1);
  assert.equal(f.staff.length, 0);
  assert.match(f.err.join('\n'), /staff-notify: skipped \(no assignee\)/);

  const g = fixture(t, { rows: [HEADERS, row({ 車検満了日: '2026-11-10' })] });
  g.deps.notifyStaff = async () => { throw new Error('RECIPIENT_UNRESOLVED'); };
  assert.equal(await g.run(), 0);
  assert.equal(g.kim.length, 1);
  assert.equal(cellOf(g.sheet.grid, HEADERS, '通知回数'), 1);
  assert.match(g.err.join('\n'), /staff-notify: failed/);

  const h = fixture(t, { rows: [HEADERS, row({ 車検満了日: '2026-11-10' })] });
  h.deps.notifyStaff = async () => { const error = new Error('no route'); error.code = 'NO_ROUTE'; throw error; };
  assert.equal(await h.run(), 0);
  assert.equal(h.kim.length, 1);
  assert.match(h.err.join('\n'), /staff-notify: skipped \(no route\)/);
});

test('kim 通知が失敗したら exit 1 で state を進めない', async (t) => {
  const f = fixture(t, { rows: [HEADERS, row({ 車検満了日: '2026-11-10' })] });
  f.deps.notifyKim = async () => { throw new Error('kim-inbox down'); };
  assert.equal(await f.run(), 1);
  assert.equal(fs.existsSync(f.stateFile), false);
  assert.equal(cellOf(f.sheet.grid, HEADERS, '通知回数'), 0);
});

test('state は一時ファイル＋rename で書き、列番号は A1 記法に変換する', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vehicle-inspection-state-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'nested', 'state.json');
  saveState(file, { V001: { lastNotifiedDate: '2026-11-03', lastStage: 7 } });
  assert.deepEqual(loadState(file), { V001: { lastNotifiedDate: '2026-11-03', lastStage: 7 } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  assert.deepEqual(loadState(path.join(home, 'absent.json')), {});
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(12), 'M');
  assert.equal(columnLetter(13), 'N');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
});
