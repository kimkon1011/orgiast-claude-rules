import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPlanUsagePayload, shouldReport, runPlanUsageReport } from './plan-usage-report.mjs';

const now = Date.parse('2026-10-21T00:15:00Z');
const usage = {
  available: true, fiveHour: { utilization: 20, resetsAt: '2026-10-21T03:00:00Z' },
  sevenDay: { utilization: 70, resetsAt: '2026-10-24T00:00:00Z' },
  scoped: [{ label: 'Fable', percent: 72, resetsAt: '2026-10-24T00:00:00Z', isActive: true, kind: 'weekly_scoped' }],
};
function fixture(t, configured = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-usage-report-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  if (configured) fs.writeFileSync(path.join(dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/private-endpoint\nFLEET_SHEET_TOKEN=fleet-secret\n');
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\nREPORTER_HOST=test-host\n');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'USER@example.com' } }));
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-secret' } }));
  const posts = [], outputs = [], usageCalls = [];
  const options = {
    home, now, args: [], output: value => outputs.push(value), identity: () => ({ hostname: 'test-host', gitEmail: 'do-not-send' }),
    usageFetchImpl: async (url, options) => {
      usageCalls.push({ url, options });
      return { ok: true, json: async () => ({ five_hour: { utilization: 20, resets_at: usage.fiveHour.resetsAt }, seven_day: { utilization: 70, resets_at: usage.sevenDay.resetsAt }, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 72, resets_at: usage.scoped[0].resetsAt }] }) };
    },
    fetchImpl: async (url, options) => { posts.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) }; },
  };
  return { home, dir, options, posts, outputs, usageCalls, state: path.join(dir, '.plan-usage-report.json'), log: path.join(dir, 'logs/plan-usage-report.log') };
}

test('envなしでは収集・送信・出力せずCLIもexit 0', async t => {
  const f = fixture(t, false);
  assert.deepEqual(await runPlanUsageReport(f.options), { skipped: 'unconfigured' });
  assert.equal(f.posts.length + f.usageCalls.length + f.outputs.length, 0);
  const result = spawnSync(process.execPath, ['tools/plan-usage-report.mjs'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, '');
});

test('10分以内は送らず、境界・時計巻戻り・forceでは送信可能', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.state, JSON.stringify({ lastSentAt: now - 599999 }));
  assert.deepEqual(await runPlanUsageReport(f.options), { skipped: 'throttled' });
  assert.equal(f.posts.length + f.usageCalls.length, 0);
  assert.equal(shouldReport(now - 600000, now), true);
  assert.equal(shouldReport(now + 1, now), true);
  assert.equal(shouldReport(undefined, now), true);
  assert.equal(shouldReport(now, now, true), true);
});

test('--hookは10分以内に送信済みなら子プロセスをspawnしない', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.state, JSON.stringify({ lastSentAt: now - 599999 }));
  let spawned = 0;
  const spawnImpl = () => {
    spawned++;
    return { on() {}, unref() {} };
  };
  assert.deepEqual(await runPlanUsageReport({ ...f.options, args: ['--hook'], spawnImpl }), { skipped: 'throttled' });
  assert.equal(spawned, 0);
  assert.equal(f.posts.length + f.usageCalls.length + f.outputs.length, 0);
});

test('--forceは間引きを無視し1回送信、成功時だけ状態と要約ログを保存', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.state, JSON.stringify({ lastSentAt: now - 1 }));
  assert.deepEqual(await runPlanUsageReport({ ...f.options, args: ['--force'] }), { ok: true });
  assert.equal(f.posts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.state)).lastSentAt, now);
  const { options } = f.posts[0];
  const body = JSON.parse(options.body);
  assert.equal(body.reportedAt, '2026-10-21 09:15');
  assert.equal(body.claudeAccount, 'USER@example.com');
  assert.equal(body.label, 'kim-PC');
  assert.equal(body.fiveHourResetsAt, usage.fiveHour.resetsAt);
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(f.usageCalls[0].options.signal instanceof AbortSignal);
  assert.doesNotMatch(options.body, /oauth-secret|accessToken|gitEmail|do-not-send/);
  const log = fs.readFileSync(f.log, 'utf8');
  assert.equal(log.trim().split('\n').length, 1);
  assert.match(log, /result=ok/);
  assert.doesNotMatch(log, /https|secret|private-endpoint/);
});

test('available:false payloadは理由を含み数値はnull、秘匿属性は明示除外', () => {
  const result = buildPlanUsagePayload({ token: 'fleet', label: 'pc', hostname: 'host', now, usage: { available: false, reason: 'HTTP 401', accessToken: 'private', fiveHour: usage.fiveHour } });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'HTTP 401');
  assert.equal(result.fiveHourPct, null);
  assert.equal(result.sevenDayResetsAt, null);
  assert.deepEqual(result.scoped, []);
  assert.doesNotMatch(JSON.stringify(result), /accessToken|private/);
  const full = buildPlanUsagePayload({ token: 'fleet', label: 'pc', hostname: 'host', now, accessToken: 'secret', usage: { ...usage, refreshToken: 'secret', scoped: [{ ...usage.scoped[0], accessToken: 'secret' }] } });
  assert.doesNotMatch(JSON.stringify(full), /accessToken|refreshToken|secret|isActive|weekly_scoped/);
});

test('認証情報なしでもavailable:falseを送信する', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dir, '.credentials.json'));
  await runPlanUsageReport(f.options);
  const body = JSON.parse(f.posts[0].options.body);
  assert.equal(body.available, false);
  assert.match(body.reason, /credentials/);
  assert.equal(f.usageCalls.length, 0);
});

for (const mode of ['http', 'gas', 'html', 'network']) test(`${mode}失敗は再試行せず状態を保持し、応答・例外の秘匿値をログに出さない`, async t => {
  const f = fixture(t);
  const previous = JSON.stringify({ lastSentAt: now - 700000 });
  fs.writeFileSync(f.state, previous);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (mode === 'network') throw new Error('https://private.invalid/oauth-secret');
    return { ok: mode !== 'http', json: async () => {
      if (mode === 'html') throw new Error('private HTML');
      return { ok: mode !== 'gas', error: 'fleet-secret oauth-secret https://private.invalid' };
    } };
  };
  assert.deepEqual(await runPlanUsageReport({ ...f.options, fetchImpl }), { ok: false });
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(f.state, 'utf8'), previous);
  assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /https|secret|private/);
});

test('--dry-runはtokenを伏せたJSONのみ表示し、送信・状態更新なし', async t => {
  const f = fixture(t);
  await runPlanUsageReport({ ...f.options, args: ['--dry-run'] });
  assert.equal(f.posts.length, 0);
  assert.equal(fs.existsSync(f.state), false);
  assert.equal(fs.existsSync(f.log), false);
  assert.equal(JSON.parse(f.outputs[0]).token, '<redacted>');
  assert.doesNotMatch(f.outputs[0], /fleet-secret|oauth-secret/);
});

test('--hookはdetached子プロセスをunrefし収集を待たず、--from-hookは再spawnしない', async t => {
  const f = fixture(t);
  let spawned = 0, unref = false;
  const spawnImpl = (exe, args, options) => {
    spawned++;
    assert.equal(exe, process.execPath);
    assert.ok(args.includes('--from-hook'));
    assert.ok(!args.includes('--hook'));
    assert.equal(options.detached, true);
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, 'ignore');
    return { on() {}, unref() { unref = true; } };
  };
  await runPlanUsageReport({ ...f.options, args: ['--hook'], spawnImpl });
  assert.equal(spawned, 1);
  assert.equal(unref, true);
  assert.equal(f.posts.length + f.usageCalls.length, 0);
  await runPlanUsageReport({ ...f.options, args: ['--from-hook'], spawnImpl });
  assert.equal(spawned, 1);
  assert.equal(f.posts.length, 1);
});
