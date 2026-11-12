import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkFleetMail } from './auto-progress-fleet-mail-check.mjs';
const now = Date.parse('2026-11-02T00:00:00Z');
const run = fields => checkFleetMail({ mail: 'mail-1', now, spawnImpl(exe, args, options) {
  assert.equal(exe, process.execPath);
  assert.match(args[0], /[\\/]tools[\\/]fleet-mail\.mjs$/);
  assert.deepEqual(args.slice(1), ['--sent-status', 'mail-1']);
  assert.equal(options.cwd, fileURLToPath(new URL('../', import.meta.url)));
  return { status: 0, stdout: Object.entries({ to: '作業用011', status: 'sent', createdAt: '2026-11-01T23:00:00Z', ...fields }).map(([k,v]) => `${k}: ${v || '(なし)'}`).join('\n') };
} });
test('返信は期限切れより優先', () => {
  const result = run({ status: 'expired', resultAt: '2026-11-02T00:00:00Z' });
  assert.equal(result.code, 0); assert.match(result.text, /返信あり/);
});
for (const status of ['expired', 'failed']) test(status, () => {
  const result = run({ status }); assert.equal(result.code, 3); assert.match(result.text, /作業用011.*未開封/);
});
test('未開封超過と境界・開封済み', () => {
  assert.equal(run({ createdAt: '2026-11-01T00:00:00Z' }).code, 1);
  const result = run({ createdAt: '2026-10-28T00:00:00Z' });
  assert.equal(result.code, 3); assert.match(result.text, /5日/);
  const seen = run({ createdAt: '2026-10-28T00:00:00Z', seenAt: '2026-11-01T00:00:00Z' });
  assert.equal(seen.code, 1); assert.match(seen.text, /対応中（開封/);
  assert.match(run({}).text, /未開封 1時間/);
});
test('照会失敗・不正な結果を停滞にしない', () => {
  for (const result of [{ status: 4 }, { status: 0, stdout: '' }, { status: null, error: new Error('timeout') }]) {
    assert.throws(() => checkFleetMail({ mail: 'mail-1', spawnImpl: () => result }));
  }
  assert.throws(() => checkFleetMail({ mail: 'mail-1', unseenHours: 0 }));
});

test('main のローカル返信出力も完了として扱う', () => {
  const result = checkFleetMail({ mail: 'mail-1', spawnImpl: () => ({ status: 0,
    stdout: 'reply: mail-reply-1\nreplyFrom: 作業用011\nreplyCreatedAt: 2026-11-02T00:00:00Z\nreplyBody:\n作業が完了しました' }) });
  assert.deepEqual(result, { code: 0, text: '作業用011 から返信あり' });
});
test('照会プロセスの異常終了を停滞と混同しない', () => {
  for (const result of [{ status: 3, stderr: 'hub不達' }, { status: 0, signal: 'SIGTERM' }]) {
    assert.throws(() => checkFleetMail({ mail: 'mail-1', spawnImpl: () => result }), /取得できません/);
  }
});
test('未開封時間を指定でき、開封後の期限切れも停滞になる', () => {
  const spawnImpl = () => ({ status: 0, stdout: 'to: 作業用011\nstatus: sent\ncreatedAt: 2026-11-01T22:00:00Z' });
  assert.equal(checkFleetMail({ mail: 'mail-1', now, unseenHours: 1, spawnImpl }).code, 3);
  assert.match(run({ status: 'expired', seenAt: '2026-11-01T23:30:00Z' }).text, /開封後.*期限切れ/);
});

test('CLI の照会・引数エラーは exit2', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./auto-progress-fleet-mail-check.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /--mail/);
});
test('spawnSync timeout は fleet-mail 最大所要以上(200秒)である', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('./auto-progress-fleet-mail-check.mjs', import.meta.url)), 'utf8');
  assert.match(source, /timeout:\s*200000/);
});
