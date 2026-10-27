import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { autoRegister } from './auto-progress-autoregister.mjs';
import { applyPromise, readLedger, ledgerFile } from './auto-progress-ledger.mjs';
import { formatDigest } from './auto-progress-digest.mjs';
import { run as watch } from './auto-progress-watch.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autoreg-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const opts = home => ({ home, owner: 'test', user: 'u', hostname: 'pc' });
const input = (prompt, sessionId = 's1') => ({ session_id: sessionId, prompt, cwd: 'C:/tmp', transcript_path: '' });
const REQUEST = 'エイトとの LINE を取得して掲載とメールを今日中にお願いします';

test('human prompt adds one open row, second prompt does not', t => {
  const home = tmp(t);
  const row = autoRegister(input(REQUEST), opts(home));
  assert.equal(row.autoRegistered, true);
  assert.equal(row.origin, 'user-request');
  assert.equal(row.status, 'open');
  assert.equal(autoRegister(input(REQUEST + ' 続き'), opts(home)), null);
  assert.equal(readLedger(ledgerFile(home)).length, 1);
});

test('task-notification and short prompts do not register', t => {
  const home = tmp(t);
  assert.equal(autoRegister(input('<task-notification>' + 'x'.repeat(50)), opts(home)), null);
  assert.equal(autoRegister(input('Stop hook feedback: ' + 'x'.repeat(50)), opts(home)), null);
  assert.equal(autoRegister(input('[Subagent hand-back] ' + 'x'.repeat(50)), opts(home)), null);
  assert.equal(autoRegister(input('<command-message>foo</command-message> ' + 'x'.repeat(50)), opts(home)), null);
  assert.equal(autoRegister(input('了解です'), opts(home)), null);
  assert.equal(readLedger(ledgerFile(home)).length, 0);
});

test('a later Stop-hook declaration supersedes the auto row', t => {
  const home = tmp(t);
  const auto = autoRegister(input(REQUEST), opts(home));
  const rows = applyPromise(readLedger(ledgerFile(home)), { ts: new Date().toISOString(), sessionId: 's1', promise: '宣言', status: 'open' });
  assert.equal(rows[0].status, 'superseded');
  assert.equal(rows[0].ts, auto.ts);
});

test('watch and digest handle an autoRegistered row without label/check', async t => {
  const home = tmp(t);
  const now = Date.now();
  const row = { ts: new Date(now - 5 * 3600000).toISOString(), pc: 'pc', user: 'u', owner: 'test', sessionId: 's1', cwd: 'C:/tmp', transcriptPath: '',
    promise: '「依頼」の依頼を進める（user 依頼・自動登録）', nextKim: 'なし', status: 'open', origin: 'user-request', autoRegistered: true };
  const text = formatDigest([row], now, 'pc');
  assert.match(text, /（自動登録）/);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(ledgerFile(home), JSON.stringify(row) + '\n');
  const summary = await watch({ home, now, dryRun: true, io: { label: 'pc', notify: async () => ({ delivered: 'dm' }) } });
  assert.ok(summary && typeof summary === 'object');
});
