import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./session-claim-collision.mjs', import.meta.url));
const self = '11111111-self';
const other = '22222222-other';
const purpose = 'aujust 制作シート同期を修正する';
const unrelated = 'keyserve の暗号鍵ローテーションを実施する';
const declaration = (text) => JSON.stringify({ type: 'assistant', content: `**[本セッションの目的]** ${text}` });
const preload = `
  import fs from 'node:fs';
  const descriptors = new Set();
  let bytes = 0;
  let scans = 0;
  const open = fs.openSync;
  const close = fs.closeSync;
  const read = fs.readSync;
  const readdir = fs.readdirSync;
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args);
    if (String(file).endsWith('.jsonl')) descriptors.add(fd);
    return fd;
  };
  fs.closeSync = (fd) => {
    descriptors.delete(fd);
    return close(fd);
  };
  fs.readSync = (fd, ...args) => {
    const count = read(fd, ...args);
    if (descriptors.has(fd)) bytes += count;
    return count;
  };
  fs.readdirSync = (...args) => {
    scans++;
    return readdir(...args);
  };
  process.on('exit', () => console.error(JSON.stringify({ bytes, scans })));
`;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-claim-cache-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  const projects = path.join(base, 'projects');
  const dir = path.join(projects, 'slug');
  fs.mkdirSync(dir, { recursive: true });
  const ownFile = path.join(dir, `${self}.jsonl`);
  const otherFile = path.join(dir, `${other}.jsonl`);
  const cacheFile = path.join(base, 'session-claim-cache.json');
  const latch = path.join(base, 'session-claim-latch', `${self}.undeclared`);
  function run(event = 'UserPromptSubmit') {
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, hook], {
      env: { ...process.env, ORGIAST_HOME: home, CLAUDE_PROJECTS_DIR: projects, CLAUDE_SESSION_ID: '' },
      input: JSON.stringify({ hook_event_name: event, session_id: self }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.error ?? result.stderr);
    return { output: result.stdout, ...JSON.parse(result.stderr) };
  }
  return { ownFile, otherFile, cacheFile, latch, run };
}

test('衝突検査と syncClaims が抽出を共有し、2回目の transcript 読み取りは0バイト', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.ownFile, declaration(purpose) + '\n');
  fs.writeFileSync(f.otherFile, declaration(purpose) + '\n');
  const first = f.run();
  assert.match(first.output, /着手衝突の疑い.*22222222/);
  assert.equal(first.bytes, fs.statSync(f.ownFile).size + fs.statSync(f.otherFile).size);
  assert.deepEqual(f.run(), { ...first, bytes: 0 });

  fs.writeFileSync(f.cacheFile, '{broken');
  assert.deepEqual(f.run(), first);
});

test('追記だけを読み、分割されたUTF-8の宣言と改行なしの末尾を従来どおり扱う', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.ownFile, declaration(purpose) + '\n');
  const previous = declaration(unrelated) + '\n';
  fs.writeFileSync(f.otherFile, previous);
  assert.equal(f.run().output, '');

  const next = Buffer.from(declaration(purpose));
  const split = next.indexOf(Buffer.from('制')) + 1;
  fs.appendFileSync(f.otherFile, next.subarray(0, split));
  assert.equal(f.run().output, '');
  assert.equal(JSON.parse(fs.readFileSync(f.cacheFile, 'utf8'))[f.otherFile].scannedBytes, Buffer.byteLength(previous));

  fs.appendFileSync(f.otherFile, next.subarray(split));
  const appended = f.run();
  assert.equal(appended.bytes, next.length);
  assert.match(appended.output, /22222222/);
  assert.deepEqual(f.run(), { ...appended, bytes: 0 });

  fs.appendFileSync(f.otherFile, '壊れた末尾\n');
  assert.equal(f.run().output, '');
});

test('縮小とmtimeの逆行は全文を読み直し、期限切れのキャッシュは保存から外す', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.ownFile, declaration(purpose) + '\n');
  fs.writeFileSync(f.otherFile, declaration(purpose) + '\n{}\n');
  assert.match(f.run().output, /22222222/);

  fs.writeFileSync(f.otherFile, '{}\n');
  assert.equal(f.run().output, '');
  fs.writeFileSync(f.otherFile, declaration(purpose) + '\n');
  const earlier = new Date(Date.now() - 60_000);
  fs.utimesSync(f.otherFile, earlier, earlier);
  assert.match(f.run().output, /22222222/);

  const old = new Date(Date.now() - 9 * 60 * 60_000);
  fs.utimesSync(f.otherFile, old, old);
  assert.equal(f.run().output, '');
  assert.equal(JSON.parse(fs.readFileSync(f.cacheFile, 'utf8'))[f.otherFile], undefined);
});

test('未宣言の PreToolUse は60秒間走査せず、期限後の宣言を検出する', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.ownFile, '{}\n');
  fs.writeFileSync(f.otherFile, declaration(purpose) + '\n');
  const first = f.run('PreToolUse');
  assert.equal(first.output, '');
  assert.ok(first.scans > 0);
  fs.appendFileSync(f.ownFile, declaration(purpose) + '\n');
  assert.deepEqual(f.run('PreToolUse'), { output: '', bytes: 0, scans: 0 });
  assert.match(f.run().output, /22222222/);

  const expired = new Date(Date.now() - 61_000);
  fs.utimesSync(f.latch, expired, expired);
  assert.match(f.run('PreToolUse').output, /22222222/);
  assert.deepEqual(f.run('PreToolUse'), { output: '', bytes: 0, scans: 0 });
});
