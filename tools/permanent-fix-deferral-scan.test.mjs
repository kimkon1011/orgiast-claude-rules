import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scan } from './permanent-fix-deferral-scan.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  return home;
}
test('3台帳で先送り・待機を検出し、無関係な行を除外、sinceと日別集計を適用', t => {
  const home = fixture(t);
  const quotes = ['恒久修正は次セッションで行う', '後日に実装する', '少々お待ちください', '修正が完了しました'];
  for (const source of scan({ home }).sources) {
    const entries = quotes.map((quote, i) => ({ ts: `2026-09-${i === 0 ? '24' : '26'}T00:00:00Z`, verdict: 'pass', sessionId: 'abcdefgh1234', excerpt: quote, violations: [{ quote }] }));
    fs.writeFileSync(source.file, entries.map(JSON.stringify).join('\n') + '\nmalformed\nnull\n');
  }
  for (const source of scan({ home }).sources) {
    assert.equal(source.total, 6);
    assert.equal(source.hits, 3);
    assert.deepEqual(source.byDay, { '2026-09-24': 1, '2026-09-26': 2 });
    assert.equal(source.rows[0].match, quotes[0]);
    assert.equal(source.rows[0].sessionId, 'abcdefgh1234');
  }
  for (const source of scan({ home, since: '2026-09-26T00:00:00Z' }).sources) {
    assert.equal(source.hits, 2);
    assert.equal(source.total, 6);
  }
});
test('台帳がなくても空のレポートを返す', t => {
  for (const source of scan({ home: fixture(t) }).sources) {
    assert.equal(source.hits, 0);
    assert.equal(source.total, 0);
    assert.deepEqual(source.rows, []);
  }
});
test('CLIはJSON・人間向け表示・不正ISOの終了コードを守る', t => {
  const home = fixture(t);
  const run = args => spawnSync(process.execPath, [path.join(import.meta.dirname, 'permanent-fix-deferral-scan.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  const json = run(['--json']);
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).sources.length, 3);
  assert.match(run([]).stdout, /hits=0 \/ 0/);
  for (const value of ['invalid', '2026-02-30T00:00:00Z', '']) {
    const result = run(['--since', value]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
});
