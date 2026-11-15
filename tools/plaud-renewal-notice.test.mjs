import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maintenanceNotice } from './plaud-renewal-notice.mjs';
import { failureToday, maintainSession, pickOtp, PREVENT_DAYS } from './plaud-reauth-auto.mjs';
import { renewalMessage } from './plaud-to-tldv.mjs';
const now = Date.parse('2026-11-06T06:00:00Z');
const day = 86400000;
function fixture(t, days = 6) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-notice-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const state = days => write('plaud-to-tldv-state.json', { session: { urt: 'fake', urtExp: (now + days * day) / 1000 } });
  state(days);
  const notice = path.join(dir, 'plaud-renewal-needed.md'); fs.writeFileSync(notice, 'old F12');
  return { home, write, state, notice };
}
test('残り6日、自動成功を読み戻して通知も古いF12も消す', t => {
  const f = fixture(t); let calls = 0;
  const out = maintenanceNotice({ home: f.home, now, runAuto: () => { calls++; f.state(30); } });
  assert.equal(calls, 1); assert.equal(out, ''); assert.equal(fs.existsSync(f.notice), false);
});
test('残り6日、当日の自動失敗だけ理由付きF12を表示', t => {
  const f = fixture(t);
  const out = maintenanceNotice({ home: f.home, now, runAuto: () => f.write('plaud-reauth-state.json', { lastFailAt: now, lastError: 'Gmail permission denied' }) });
  assert.match(out, /F12/); assert.match(out, /Gmail permission denied/); assert.match(out, /残り 6 日/);
  assert.equal(fs.readFileSync(f.notice, 'utf8'), out + '\n');
});
test('前日の失敗・子プロセスの未記録終了ではF12を表示しない', t => {
  const f = fixture(t); f.write('plaud-reauth-state.json', { lastFailAt: now - day, lastError: 'old failure' });
  assert.equal(maintenanceNotice({ home: f.home, now, runAuto: () => ({ status: 1 }) }), '');
  assert.equal(fs.existsSync(f.notice), false);
});
test('残り8日は再認証なし、ちょうど7日から試す', t => {
  const f = fixture(t, 8); let calls = 0;
  const runAuto = () => { calls++; f.state(30); };
  maintenanceNotice({ home: f.home, now, runAuto }); assert.equal(calls, 0);
  f.state(7); maintenanceNotice({ home: f.home, now, runAuto }); assert.equal(calls, 1);
  assert.equal(PREVENT_DAYS, 7);
});
test('失効済みも自動復旧を先に試す', t => {
  const f = fixture(t, -1);
  assert.equal(maintenanceNotice({ home: f.home, now, runAuto: () => f.state(30) }), '');
});
test('日付は日本時間、成功後・未来の失敗は採用しない', () => {
  const midnight = Date.parse('2026-11-06T15:00:00Z');
  assert.equal(failureToday({ lastFailAt: midnight - 1, lastError: 'old' }, midnight), '');
  assert.equal(failureToday({ lastFailAt: now, lastOkAt: now + 1, lastError: 'old' }, now + 2), '');
  assert.equal(failureToday({ lastFailAt: now + 1, lastError: 'future' }, now), '');
  assert.equal(renewalMessage('warning', 6, ''), '');
});
test('同期処理も残り6日に自動再認証してから状態を保存', async () => {
  const session = { urt: 'fake', urtExp: (now + 6 * day) / 1000 }; let saved = 0;
  assert.equal(await maintainSession(session, () => saved++, { now, reauth: async s => { s.urtExp = (now + 30 * day) / 1000; return true; } }), '');
  assert.equal(saved, 1);
});
test('同期処理の自動失敗は記録された当日の理由を返す', async () => {
  assert.equal(await maintainSession({ urtExp: 0 }, () => assert.fail(), { now, reauth: async () => false,
    readRecord: () => ({ lastFailAt: now, lastError: 'OTP timeout' }) }), 'OTP timeout');
});
test('OTP は送信時刻以降の6桁コードだけを選ぶ', () => {
  assert.equal(pickOtp([{ subject: '123456 is your Plaud login code', date: new Date(now - day).toISOString() },
    { subject: '654321 is your Plaud login code', date: new Date(now).toISOString() }], now), '654321');
});

test('旧SessionStartフックを正本へ移行し、再登録しても重複しない', async t => {
  const { copyDispatchRegistration, readHookSettings } = await import('./fixtures/read-hook-settings.mjs');
  const { execFileSync } = await import('node:child_process');
  const f = fixture(t);
  const repo = path.join(f.home, 'repo'); fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  copyDispatchRegistration(repo);
  for (const name of ['register-hooks.mjs', 'plaud-renewal-notice.mjs']) fs.copyFileSync(path.resolve('tools', name), path.join(repo, 'tools', name));
  fs.writeFileSync(path.join(f.home, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const settings = path.join(f.home, '.claude', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "C:\\Users\\uers\\.claude\\hooks\\plaud-renewal-notice.mjs"', timeout: 5 }] }] } }));
  const run = () => execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'],
    { env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_REPO: repo }, timeout: 20000 });
  run();
  const hooks = () => readHookSettings(settings).hooks.SessionStart.flatMap(g => g.hooks).filter(h => h.command.includes('plaud-renewal-notice.mjs'));
  assert.equal(hooks().length, 1); assert.ok(hooks()[0].command.includes(repo)); assert.equal(hooks()[0].timeout, 300);
  run(); assert.equal(hooks().length, 1);
});
