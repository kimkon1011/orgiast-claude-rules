import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTROLS, detect, scan, selftest } from './handoff-audit-drive-share-scan.mjs';

test('detect: 陽性5件・陰性5件', () => {
  for (const c of CONTROLS) assert.equal(detect(c.text), c.want, c.name);
});

test('selftest: 全通過', () => {
  assert.deepEqual(selftest(), { total: 10, passed: 10, failures: [] });
});

test('scan: 3ソースを走査して集計する', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-share-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const since = Date.now() - 60_000;
  const claude = path.join(home, '.claude');
  const project = path.join(claude, 'projects', 'p');
  const runs = path.join(claude, 'auto-session', 'runs');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  const ts = new Date(since + 1_000).toISOString();

  fs.writeFileSync(path.join(claude, 'handoff-audit-ledger.jsonl'), [
    JSON.stringify({ ts, sessionId: 'ledger-positive', excerpt: 'Drive の共有設定をお願いします' }),
    JSON.stringify({ ts, sessionId: 'ledger-negative', excerpt: '共有フォルダの一覧を取得しました' }),
  ].join('\n'), 'utf8');

  const transcript = path.join(project, 's.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ timestamp: ts, message: { content: '権限を付与してください' } }),
    JSON.stringify({ timestamp: ts, message: { content: [{ type: 'text', text: '共有フォルダの一覧を取得しました' }] } }),
    JSON.stringify({ timestamp: ts, isSidechain: true, message: { content: 'Drive の共有設定をお願いします' } }),
  ].join('\n'), 'utf8');

  const summary = path.join(runs, 'x.summary.md');
  fs.writeFileSync(summary, 'このフォルダを SA に閲覧者で共有してください', 'utf8');
  const after = new Date(since + 2_000);
  fs.utimesSync(transcript, after, after);
  fs.utimesSync(summary, after, after);

  const report = scan({ home, since });
  assert.equal(report.hits, 3);
  assert.deepEqual(report.ledger, { total: 2, scanned: 2 });
  assert.deepEqual(report.transcript, { files: 1, filesScanned: 1, turnsScanned: 2 });
  assert.deepEqual(report.runs, { files: 1, filesScanned: 1 });
  assert.deepEqual(report.rows.map((r) => r.src), ['ledger', 'transcript', 'runs']);
});

