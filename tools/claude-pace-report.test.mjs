import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSchema } from './lib/json-schema-check.mjs';
import { datePair, judgeGrokbot, readGrokbotInput, readRegistrationStatus, main } from './claude-pace-report.mjs';
import { reportPaths, publishReport } from './claude-pace-report-publish.mjs';
import { buildReport, shouldReport, DAY_TARGET_PCT, aggregateAccountSnapshots } from './claude-pace-report.mjs';

const config = {
  targetLanding: 90,
  staleHours: 3,
  reportHost: '011',
  reportFallbackHost: '018',
};

test('結論は日次差でなく status をそのまま集計する', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z');
  const onpace = buildReport({
    snapshots: [{ ts: new Date(now).toISOString(), account: 'a@x', host: '018', sevenDayPct: 20, status: 'onpace' }],
    config,
    now,
  }).markdown;
  assert.match(onpace, /遅れ 0 \/ ちょうど 1 \/ 進みすぎ 0/);

  const mixed = buildReport({
    snapshots: [
      { ts: new Date(now).toISOString(), account: 'behind@x', host: '014', sevenDayPct: 10, status: 'behind' },
      { ts: new Date(now).toISOString(), account: 'ahead@x', host: '011', sevenDayPct: 80, status: 'ahead' },
    ],
    config,
    now,
  }).markdown;
  assert.match(mixed, /遅れ 1 \/ ちょうど 0 \/ 進みすぎ 1/);
});

test('buildReport がアカウント別・予測着地・措置・次作業・新サービスを含む', () => {
  const now = Date.parse('2026-11-27T22:30:00.000Z');
  const snapshots = [
    {
      ts: new Date(now - 25 * 3600_000).toISOString(),
      host: '011',
      account: 'cr@orgiast.jp',
      sevenDayPct: 40,
      target: 38,
      deltaPt: 2,
      projectedLanding: 88,
      status: 'onpace',
      launch: false,
      hold: false,
      reasons: [],
      codex: [{ window: 300, usedPercent: 12 }],
    },
    {
      ts: new Date(now).toISOString(),
      host: '011',
      account: 'cr@orgiast.jp',
      sevenDayPct: 52,
      target: 45,
      deltaPt: 7,
      projectedLanding: 92,
      status: 'ahead',
      launch: false,
      hold: true,
      reasons: ['ahead'],
      codex: [{ window: 300, usedPercent: 15 }],
    },
    {
      ts: new Date(now).toISOString(),
      host: '014',
      account: 'seisaku-team@orgiast.jp',
      sevenDayPct: 30,
      target: 45,
      deltaPt: -15,
      projectedLanding: 70,
      status: 'behind',
      launch: true,
      hold: false,
      reasons: ['behind'],
      codex: [],
    },
  ];
  const queue = {
    tasks: [
      { id: 'Q-014-01', host: '014', priority: 1, title: 'ブース調査', prompt: '調査', state: '未着手' },
      { id: 'Q-018-01', host: '018', priority: 1, title: '学会リスト', prompt: 'リスト', state: '未着手' },
      { id: 'Q-011-01', host: '011', priority: 2, title: '粗利ゲート', prompt: '実装', state: '未着手' },
    ],
    newOfferings: [
      { id: 'N-01', host: '014', title: 'Reブース販売ページ', state: '着手' },
      { id: 'N-02', host: '018', title: '学会パッケージ', state: '未着手' },
    ],
  };
  const { markdown, json } = buildReport({ snapshots, queue, config, now });
  assert.match(markdown, /cr@orgiast\.jp/);
  assert.match(markdown, /seisaku-team@orgiast\.jp/);
  assert.match(markdown, /予測着地/);
  assert.match(markdown, /92\.0%/);
  assert.match(markdown, /進みすぎ|hold|遅れ|作業起動/);
  assert.match(markdown, /Q-014-01/);
  assert.match(markdown, /Reブース販売ページ/);
  assert.match(markdown, /Codex/);
  assert.match(markdown, new RegExp(String(DAY_TARGET_PCT).replace('.', '\\.')));
  assert.ok(json.accounts.length >= 2);
  assert.ok(json.nextTasks.length >= 1);
  assert.equal(json.newOfferings.length, 1);
});

test('計測できなかったPCが本文に出る', () => {
  const { markdown, json } = buildReport({
    snapshots: [
      { host: '999', missing: true, missingReason: 'Drive読取失敗' },
    ],
    queue: { tasks: [], newOfferings: [] },
    config,
    now: Date.parse('2026-11-27T22:30:00.000Z'),
    missingHosts: [{ host: '004', reason: 'paceファイル無し' }],
  });
  assert.match(markdown, /計測できなかったPC/);
  assert.match(markdown, /999/);
  assert.match(markdown, /004/);
  assert.ok(json.unmeasured.some((m) => m.host === '004'));
});

test('shouldReport は 011 既定、011 が stale なら 018', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z');
  const fresh = { '011': now - 30 * 60_000 };
  assert.equal(shouldReport('011', config, fresh, now), true);
  assert.equal(shouldReport('018', config, fresh, now), false);
  assert.equal(shouldReport('014', config, fresh, now), false);

  const stale = { '011': now - 4 * 3600_000 };
  assert.equal(shouldReport('011', config, stale, now), false);
  assert.equal(shouldReport('018', config, stale, now), true);
  assert.equal(shouldReport('014', config, stale, now), false);

  assert.equal(shouldReport('018', config, {}, now), true);
});

test('aggregateAccountSnapshots が前日増分を付ける', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z');
  const rows = [
    { ts: new Date(now - 24 * 3600_000).toISOString(), account: 'a@x', host: '011', sevenDayPct: 40, projectedLanding: 80 },
    { ts: new Date(now).toISOString(), account: 'a@x', host: '011', sevenDayPct: 50, projectedLanding: 85, status: 'onpace' },
  ];
  const [a] = aggregateAccountSnapshots(rows, now);
  assert.equal(a.dayDelta, 10);
  assert.ok(Math.abs(a.dayDeltaVsTarget - (10 - DAY_TARGET_PCT)) < 1e-9);
  assert.equal(a.unusedForecast, 15);
});

const root = path.resolve(import.meta.dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const schema = readJson('docs/claude-pace-report-schema.json');
const initial = readJson('reports/claude-pace/grokbot/2026-11-27.json');
const reportNow = Date.parse('2026-11-27T12:52:00Z');
const fixtureReport = (overrides = {}) => buildReport({
  now: reportNow, config: { ...config, accounts: { 'a@x': { pcs: ['011', '018'] } } },
  snapshots: [{ ts: new Date(reportNow).toISOString(), host: '011', account: 'a@x', fiveHourPct: 7,
    fiveHourResetsAt: '2026-11-27T16:00:00Z', sevenDayPct: 49.6, sevenDayResetsAt: initial.weeklyResetsAt,
    target: 29.7, deltaPt: 19.9, effectiveTolerance: 6.7, status: 'ahead', hold: true, projectedLanding: 150.3,
    codex: [{ window: 'primary', usedPercent: 54 }] }],
  grokbot: initial, ...overrides,
});

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-report-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('日報JSONはスキーマを満たし、グロボ判定と日時の対を含む', () => {
  const { markdown, json } = fixtureReport();
  assert.deepEqual(checkSchema(schema, json), []);
  assert.equal(json.grokbot.received, true);
  assert.equal(json.grokbot.status, 'ahead');
  assert.equal(json.grokbot.statusJa, '進みすぎ');
  for (const [jst, iso] of [[json.generatedAtJst, json.generatedAtIso],
    [json.accounts[0].fiveHour.resetsAtJst, json.accounts[0].fiveHour.resetsAtIso],
    [json.accounts[0].sevenDay.resetsAtJst, json.accounts[0].sevenDay.resetsAtIso],
    [json.pcs[0].lastSnapshotAtJst, json.pcs[0].lastSnapshotAtIso],
    [json.grokbot.weeklyResetsAtJst, json.grokbot.weeklyResetsAtIso],
    [json.grokbot.onDemandResetsAtJst, json.grokbot.onDemandResetsAtIso]]) {
    assert.match(jst, /\+09:00$/);
    assert.match(iso, /Z$/);
    assert.equal(Date.parse(jst), Date.parse(iso));
  }
  assert.match(markdown, /github\.com\/kimkon1011\/orgiast-claude-rules\/blob\/main/);
  assert.match(markdown, /raw\.githubusercontent\.com\/kimkon1011\/orgiast-claude-rules\/main\/reports\/claude-pace\/latest\.json/);
  assert.match(markdown, /Drive.*https:\/\/drive\.google\.com/);
  assert.match(markdown, /018 \| 未確認/);
  assert.equal(json.pcs.find((p) => p.host === '018').registered, null);
});

test('グロボが当日未受領なら全値null、前日分は読まない', (t) => {
  const repo = tempHome(t);
  fs.mkdirSync(path.join(repo, 'reports/claude-pace/grokbot'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'reports/claude-pace/grokbot/2026-11-27.json'), JSON.stringify(initial));
  assert.equal(readGrokbotInput('2026-11-27', repo).received, true);
  const grokbot = readGrokbotInput('2026-11-28', repo);
  const { json, markdown } = fixtureReport({ now: reportNow + 86400_000, grokbot });
  assert.equal(json.grokbot.received, false);
  for (const [key, value] of Object.entries(json.grokbot)) if (!['received', 'note'].includes(key)) assert.equal(value, null, key);
  assert.match(markdown, /グロボ分 未受領/);
  assert.match(markdown, /2026-11-28\.json が無い/);
  assert.deepEqual(checkSchema(schema, json), []);
  fs.writeFileSync(path.join(repo, 'reports/claude-pace/grokbot/2026-11-28.json'), '{broken');
  assert.equal(readGrokbotInput('2026-11-28', repo).received, false);
  fs.writeFileSync(path.join(repo, 'reports/claude-pace/grokbot/2026-11-28.json'), JSON.stringify(initial));
  assert.equal(readGrokbotInput('2026-11-28', repo).received, false);
});

test('経過33%・49.6%は既存規則で進みすぎ', () => {
  const now = Date.parse(initial.weeklyResetsAt) - 7 * 86400_000 * 0.67;
  const result = judgeGrokbot(initial, now);
  assert.equal(result.status, 'ahead');
  assert.equal(result.statusJa, '進みすぎ');
  assert.ok(Math.abs(result.targetLinePct - 29.7) < 1e-8);
  assert.ok(Math.abs(result.deltaPt - 19.9) < 1e-8);
  assert.ok(Math.abs(result.effectiveTolerancePt - 6.7) < 1e-8);
});

test('初回実測データがグロボ入力スキーマを満たす', () => {
  const inputSchema = readJson('docs/claude-pace-grokbot-schema.json');
  assert.deepEqual(checkSchema(inputSchema, initial), []);
  for (const input of [{ ...initial, weeklyResetsAt: '2026-12-02T14:42' },
    { ...initial, selfExecutedTasks: 1.5 }, { ...initial, weeklyUsedPercent: -1 }]) {
    assert.ok(checkSchema(inputSchema, input).length);
  }
});

test('登録済み・未反映と理由、欠損時の未確認を表示する', (t) => {
  const repo = tempHome(t);
  assert.deepEqual(readRegistrationStatus(repo).hosts, {});
  fs.mkdirSync(path.join(repo, 'reports/claude-pace'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'reports/claude-pace/registration.json'), JSON.stringify({ hosts: {
    '011': { registered: true, note: '' }, '018': { registered: false, note: 'タスク未登録' },
  } }));
  const { markdown } = fixtureReport({ registration: readRegistrationStatus(repo) });
  assert.match(markdown, /011 \| 登録済み/);
  assert.match(markdown, /018 \| 未反映 \| タスク未登録/);
});

test('古い台帳・未来の台帳を今日の計測に使わず、履歴なしの前日消費はnull', () => {
  const { json } = fixtureReport();
  assert.equal(json.accounts[0].previousDayConsumedPt, null);
  const old = fixtureReport({ now: reportNow + 86400_000 }).json;
  assert.equal(old.accounts.length, 0);
  assert.equal(old.pcs[0].measured, false);
  const future = fixtureReport({ now: reportNow - 3600_000 }).json;
  assert.equal(future.accounts.length, 0);
});

test('reportPathsが予定3パスを返し、パス逸脱を拒否する', () => {
  assert.deepEqual(reportPaths('2026-11-28'), { jsonPath: 'reports/claude-pace/2026-11-28.json',
    mdPath: 'reports/claude-pace/2026-11-28.md', latestPath: 'reports/claude-pace/latest.json' });
  assert.throws(() => reportPaths('../escape'));
  assert.throws(() => reportPaths('2026-02-30'));
});

test('両dry-runはclone・commit・push・Drive・通知・ローカル書込をしない', async (t) => {
  const home = tempHome(t);
  const fail = () => assert.fail('副作用が呼ばれた');
  const result = await main(['--dry-run'], { home, nowMs: reportNow, config, queue: {}, getDriveToken: fail,
    publishReport: fail, notifyKim: fail, print: () => {} });
  const printed = [];
  const published = await publishReport({ report: result, home, dryRun: true, run: fail, getToken: fail, print: (s) => printed.push(s) });
  assert.equal(printed.length, 3);
  assert.equal(published.files[published.paths.jsonPath], published.files[published.paths.latestPath]);
  assert.deepEqual(fs.readdirSync(home), []);
});

/** git/gh とDriveを注入して本番副作用の順序と配信内容を検証する。 */
function publishFixture(t, { reject = false, existingPr = false, failDrive = false, failUpload = false } = {}) {
  const home = tempHome(t), calls = [], uploads = [];
  let rejected = false;
  const run = (exe, args, cwd) => {
    calls.push([exe, ...args]);
    if (args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
    if (args[0] === 'diff') return 'reports/claude-pace/2026-11-27.md';
    if (args[0] === 'push' && args.at(-1) === 'main' && reject && !rejected) {
      rejected = true;
      throw Object.assign(new Error('push rejected'), { pushRejected: true });
    }
    if (args[0] === 'ls-remote') return existingPr ? 'sha refs/heads/report/claude-pace-2026-11-27' : '';
    if (exe === 'gh' && args[1] === 'list') return existingPr ? '[{"url":"https://github.com/example/pull/1"}]' : '[]';
    if (exe === 'gh' && args[1] === 'create') return 'https://github.com/example/pull/1';
    return '';
  };
  return { home, calls, uploads, run, getToken: async () => {
    if (failDrive) throw new Error('sensitive upstream details');
    return 'test-token';
  }, driveFiles: {
    findOrCreateFolder: async (_token, name, parent) => { calls.push(['folder', name, parent]); return { id: name === 'claude-pace' ? 'pace-folder' : 'knowhow-folder' }; },
    listFiles: async () => [{ name: 'latest.md', id: 'latest-id' }],
    uploadFileContent: async (_token, args) => { if (failUpload) throw new Error('sensitive upstream details'); uploads.push(args); },
  } };
}

test('mainに3ファイルだけ配信し、Drive日付分とlatest.mdは同じ本文', async (t) => {
  const f = publishFixture(t);
  const result = await publishReport({ ...f, report: fixtureReport() });
  assert.equal(result.fallback, false);
  assert.equal(result.driveError, null);
  assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[0].name, 'claude-pace-2026-11-27.md');
  assert.equal(f.uploads[1].fileId, 'latest-id');
  assert.equal(f.uploads[0].content, f.uploads[1].content);
  assert.equal(f.uploads[0].content, result.markdown);
  assert.equal(f.calls.some((c) => c[0] === 'gh'), false);
  const dir = path.join(f.home, '.claude/claude-pace-reports-repo');
  assert.equal(fs.readFileSync(path.join(dir, result.paths.mdPath), 'utf8'), result.markdown);
  assert.equal(fs.readFileSync(path.join(dir, result.paths.jsonPath), 'utf8'), fs.readFileSync(path.join(dir, result.paths.latestPath), 'utf8'));
});

for (const existingPr of [false, true]) test(`push拒否は同日ブランチへ自動フォールバック（既存PR=${existingPr}）`, async (t) => {
  const f = publishFixture(t, { reject: true, existingPr });
  const result = await publishReport({ ...f, report: fixtureReport() });
  assert.equal(result.fallback, true);
  assert.match(result.markdown, /フォールバック/);
  assert.equal(f.calls.some((c) => c[0] === 'gh' && c[2] === 'create'), !existingPr);
  assert.ok(f.calls.some((c) => c[0] === 'gh' && c.includes('--auto') && c.includes('--squash')));
  assert.equal(f.uploads[0].content, result.markdown);
});

for (const failUpload of [false, true]) test(`Drive失敗を握り潰さず日報へ記録して継続（upload=${failUpload}）`, async (t) => {
  const f = publishFixture(t, { failDrive: !failUpload, failUpload });
  const result = await publishReport({ ...f, report: fixtureReport() });
  assert.ok(result.driveError);
  assert.match(result.markdown, /driveError: Drive/);
  assert.doesNotMatch(result.markdown, /sensitive/);
  assert.equal(fs.readFileSync(path.join(f.home, '.claude/claude-pace-reports-repo', result.paths.mdPath), 'utf8'), result.markdown);
  assert.ok(f.calls.some((c) => c[1] === 'push'));
});

test('本番mainはpublisherを呼び、長い通知でも末尾に全URLを残す', async (t) => {
  const home = tempHome(t);
  let published = false, body;
  await main(['--force'], { home, nowMs: reportNow, config, snapshots: [], queue: {}, print: () => {},
    publishReport: async ({ report }) => { published = true; return { markdown: `長い本文${'x'.repeat(2000)}\n${report.markdown}`, driveError: 'Drive 接続失敗' }; },
    notifyKim: async (text) => { body = text; return { delivered: 'test' }; },
  });
  assert.equal(published, true);
  for (const suffix of ['2026-11-27.json', '2026-11-27.md', 'latest.json']) assert.ok(body.includes(`/reports/claude-pace/${suffix}`));
  assert.match(body, /raw\.githubusercontent\.com/);
  assert.match(body, /drive\.google\.com/);
});

test('ミリ秒付き日時もJSTとUTCが同じ瞬間になる', () => {
  const { jst, iso } = datePair('2026-11-27T13:33:41.337Z');
  assert.equal(jst, '2026-11-27T22:33:41.337+09:00');
  assert.equal(Date.parse(jst), Date.parse(iso));
});

test('既存の専用クローンだけを検証後resetし、別リポジトリを拒否する', async (t) => {
  const f = publishFixture(t);
  const dir = path.join(f.home, '.claude/claude-pace-reports-repo');
  fs.mkdirSync(dir, { recursive: true });
  let wrong = true;
  const run = (exe, args, cwd) => {
    if (args[0] === 'rev-parse') return wrong ? f.home : dir;
    if (args[0] === 'remote') return 'https://github.com/kimkon1011/orgiast-claude-rules.git';
    return f.run(exe, args, cwd);
  };
  await assert.rejects(publishReport({ ...f, run, report: fixtureReport(), clearLock: () => {} }), /root mismatch/);
  assert.equal(f.calls.some((c) => c[1] === 'reset'), false);
  wrong = false;
  await publishReport({ ...f, run, report: fixtureReport(), clearLock: () => {} });
  const commands = f.calls.filter((c) => c[0] === 'git').map((c) => c[1]);
  assert.ok(commands.indexOf('fetch') < commands.indexOf('reset'));
  assert.ok(commands.indexOf('reset') < commands.indexOf('checkout'));
  assert.equal(commands.includes('clone'), false);
});

test('認証などpush拒否以外の失敗ではPRを作らない', async (t) => {
  const f = publishFixture(t);
  const run = (exe, args, cwd) => {
    if (args[0] === 'push') throw new Error('authentication failed');
    return f.run(exe, args, cwd);
  };
  await assert.rejects(publishReport({ ...f, run, report: fixtureReport() }), /authentication/);
  assert.equal(f.calls.some((c) => c[0] === 'gh'), false);
});
