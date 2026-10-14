import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeliver } from './cafe-digest-deliver.mjs';

const section = '<!-- CAFE-DIGEST-START -->\n## カフェ\n### 未処理の提案\n- 平日1500円を試す\n<!-- CAFE-DIGEST-END -->';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-deliver-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  fs.mkdirSync(base);
  const digestFile = path.join(base, 'cafe-digest.md');
  fs.writeFileSync(digestFile, `外側\n${section}\n末尾`);
  const stateFile = path.join(base, 'line-openchat', 'cafe-deliver-state.json');
  const calls = [], logs = [];
  const spawn = (command, args, options) => {
    const bodyFile = args[args.indexOf('--body-file') + 1];
    calls.push({ command, args, options, bodyFile, body: fs.readFileSync(bodyFile, 'utf8') });
    return { status: 0, stdout: '送信済み: mail-20261014-1234\n', stderr: '' };
  };
  const run = (options = {}) => runDeliver({ home, spawn, log: (s) => logs.push(s), ...options });
  return { home, digestFile, stateFile, calls, logs, run };
}

test('初回送信の前置き・区間・既定宛先・mail idを保持し一時ファイルを削除', async (t) => {
  const f = fixture(t), result = await f.run();
  assert.deepEqual(result, { status: 'ok:送信 mail-20261014-1234', exitCode: 0 });
  const call = f.calls[0];
  assert.equal(call.command, process.execPath);
  assert.equal(path.basename(call.args[0]), 'fleet-mail.mjs');
  assert.deepEqual(call.args.slice(1, 6), ['--send', '--to', 'cafe015-PC', '--kind', 'note']);
  assert.equal(call.options.shell, false);
  assert.ok(call.body.startsWith('# ☕ カフェ改善ダイジェスト（kim-PC → cafe015-PC 自動配達）\n'));
  assert.match(call.body, /他店オーナーの伝聞で未検証/);
  assert.match(call.body, /next-session.md の残TODO/);
  assert.match(call.body, /`node tools\/notify-kim\.mjs` で DM を送る/);
  assert.ok(call.body.endsWith(section + '\n'));
  assert.doesNotMatch(call.body, /外側|末尾/);
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.match(state.lastHash, /^[a-f0-9]{64}$/);
  assert.equal(state.lastMailId, 'mail-20261014-1234');
  assert.ok(Number.isFinite(Date.parse(state.lastSentAt)));
  assert.equal(fs.existsSync(call.bodyFile), false);
  assert.equal(f.logs.at(-1), result.status);
});

test('同一ハッシュはskipし区間外の変更も送らない', async (t) => {
  const f = fixture(t);
  await f.run();
  const state = fs.readFileSync(f.stateFile, 'utf8');
  fs.appendFileSync(f.digestFile, '\n区間外の追記');
  assert.equal((await f.run()).status, 'skip:変更なし');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), state);
});

test('--forceは同一内容でも送信し--toを引き渡す', async (t) => {
  const f = fixture(t);
  await f.run();
  assert.equal((await f.run({ args: ['--force', '--to', 'test-PC'] })).exitCode, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].args[3], 'test-PC');
});

test('区間内の変更は再配達する', async (t) => {
  const f = fixture(t);
  await f.run();
  fs.writeFileSync(f.digestFile, section.replace('1500', '2000'));
  await f.run();
  assert.equal(f.calls.length, 2);
});

test('送信失敗はerrorと終了コード1を返しstateを更新しない', async (t) => {
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

test('dry-runは本文と宛先を表示し送信もstate作成もしない', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run({ args: ['--dry-run', '--to', 'preview-PC'] })).exitCode, 0);
  assert.match(f.logs[0], /宛先: preview-PC/);
  assert.ok(f.logs[0].includes(section));
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('ファイルまたは完全なマーカーが無ければskipする', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.digestFile, '<!-- CAFE-DIGEST-START -->\n未完');
  assert.equal((await f.run()).status, 'skip:ダイジェストなし');
  fs.unlinkSync(f.digestFile);
  assert.equal((await f.run()).status, 'skip:ダイジェストなし');
  assert.equal(f.calls.length, 0);
});

test('spawn例外はerrorとなり一時ファイルも残さない', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run({ spawn: () => { throw new Error('spawn失敗'); } })).exitCode, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)), []);
});

test('成功してmail idがなくてもhashを保存し再送を防ぐ', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run({ spawn: () => ({ status: 0, stdout: '' }) })).status, 'ok:送信 ID不明');
  assert.equal((await f.run()).status, 'skip:変更なし');
});
