import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeliver } from './minpaku-digest-deliver.mjs';

const section = '<!-- MINPAKU-DIGEST-START -->\n## 民泊\n### 未処理の提案\n- 清掃費見直し\n<!-- MINPAKU-DIGEST-END -->';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minpaku-deliver-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  fs.mkdirSync(base);
  const digestFile = path.join(base, 'minpaku-digest.md');
  fs.writeFileSync(digestFile, `外側\n${section}\n末尾`);
  const stateFile = path.join(base, 'line-openchat', 'minpaku-deliver-state.json');
  const calls = [], logs = [];
  const spawn = (command, args, options) => {
    const bodyFile = args[args.indexOf('--body-file') + 1];
    calls.push({ command, args, options, bodyFile, body: fs.readFileSync(bodyFile, 'utf8') });
    return { status: 0, stdout: '送信済み: mail-20261111-9999\n', stderr: '' };
  };
  const run = (options = {}) => runDeliver({ home, spawn, log: (s) => logs.push(s), ...options });
  return { home, digestFile, stateFile, calls, logs, run };
}

test('minpaku 初回送信の前置き・区間・既定宛先作業用004・mail idを保持し一時ファイルを削除', async (t) => {
  const f = fixture(t), result = await f.run();
  assert.deepEqual(result, { status: 'ok:送信 mail-20261111-9999', exitCode: 0 });
  const call = f.calls[0];
  assert.equal(call.command, process.execPath);
  assert.equal(path.basename(call.args[0]), 'fleet-mail.mjs');
  assert.deepEqual(call.args.slice(1, 6), ['--send', '--to', '作業用004', '--kind', 'note']);
  assert.equal(call.options.shell, false);
  assert.ok(call.body.startsWith('# 🏠 民泊改善ダイジェスト（kim-PC → 作業用004 自動配達）\n'));
  assert.match(call.body, /他のオーナーの伝聞で未検証/);
  assert.match(call.body, /nf-minpaku-automation\/analysis\/0openchat\//);
  assert.match(call.body, /全室稼働95%・月次黒字/);
  assert.match(call.body, /kim-inbox（node tools\/kim-inbox\.mjs）/);
  assert.match(call.body, /Discord の DM は使わない/);
  assert.match(call.body, /特区民泊の最低2泊を下回る提案は法令違反のため即却下する/);
  assert.ok(call.body.endsWith(section + '\n'));
  assert.doesNotMatch(call.body, /外側|末尾/);
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.match(state.lastHash, /^[a-f0-9]{64}$/);
  assert.equal(state.lastMailId, 'mail-20261111-9999');
  assert.ok(Number.isFinite(Date.parse(state.lastSentAt)));
  assert.equal(fs.existsSync(call.bodyFile), false);
  assert.equal(f.logs.at(-1), result.status);
});

test('minpaku 同一ハッシュはskipし区間外の変更も送らない', async (t) => {
  const f = fixture(t);
  await f.run();
  const state = fs.readFileSync(f.stateFile, 'utf8');
  fs.appendFileSync(f.digestFile, '\n区間外の追記');
  assert.equal((await f.run()).status, 'skip:変更なし');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), state);
});

test('minpaku --forceは同一内容でも送信し--toを引き渡す', async (t) => {
  const f = fixture(t);
  await f.run();
  assert.equal((await f.run({ args: ['--force', '--to', 'custom-PC'] })).exitCode, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].args[3], 'custom-PC');
});

test('minpaku 区間内の変更は再配達する', async (t) => {
  const f = fixture(t);
  await f.run();
  fs.writeFileSync(f.digestFile, section.replace('清掃費見直し', '価格改定'));
  await f.run();
  assert.equal(f.calls.length, 2);
});

test('minpaku 送信失敗はerrorと終了コード1を返しstateを更新しない', async (t) => {
  const f = fixture(t);
  await f.run();
  const state = fs.readFileSync(f.stateFile, 'utf8');
  let bodyFile;
  const result = await f.run({ args: ['--force'], spawn: (_cmd, args) => {
    bodyFile = args[args.indexOf('--body-file') + 1];
    return { status: 1, stderr: '失敗\n' + '長'.repeat(200) };
  } });
  assert.equal(result.exitCode, 1);
  assert.match(result.status, /^error:失敗 /);
  assert.equal(result.status.length, 126);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), state);
  assert.equal(fs.existsSync(bodyFile), false);
  assert.equal(f.logs.at(-1), result.status);
});

test('minpaku dry-runは本文と宛先を表示し送信もstate作成もしない', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run({ args: ['--dry-run', '--to', 'preview-PC'] })).exitCode, 0);
  assert.match(f.logs[0], /宛先: preview-PC/);
  assert.ok(f.logs[0].includes(section));
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.stateFile), false);
});
