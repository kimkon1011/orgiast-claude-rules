import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';

const cli = fileURLToPath(new URL('./kim-inbox-dedupe-backfill.mjs', import.meta.url));

test('backfill previews, backs up and closes duplicate asks, then is safe to rerun', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inbox = path.join(home, '.claude', 'kim-inbox');
  fs.mkdirSync(inbox, { recursive: true });
  let serial = 0;
  function seed(text, fields = {}) {
    const n = String(++serial).padStart(2, '0');
    const id = `ki-202611190000${n}-0000`;
    const file = path.join(inbox, id + '.json');
    fs.writeFileSync(file, JSON.stringify({
      id, text, createdAt: `2026-11-19T00:00:${n}.000Z`, kind: 'ask', status: 'open',
      shownSessions: [], shownCount: 0, ...fields,
    }));
    return { id, file };
  }
  const ts = '2026-11-18T01:00:00.000Z';
  const escalation = days => `【要対応・kim の判断待ち ${days}日】確認（セッション abcdef12 / 台帳 ts ${ts}）`;
  const answerTime = '2026-11-19T12:00:00.000Z';
  const answered = seed(escalation(1), { status: 'answered', answer: '進める', answeredAt: answerTime });
  const open = seed(escalation(2), { dedupeKey: 'old-escalation-key' });
  seed(escalation(3), { status: 'answered', answer: '古い回答', answeredAt: '2026-11-19T10:00:00.000Z' });
  const older = seed('Ａ　判断待ち ２日\n確認 42');
  const newer = seed('A 判断待ち 10 日 確認 42');
  const distinct = seed('A 判断待ち 10日 確認 43');
  const dropped = seed('別文面', { status: 'dropped', answer: '不要', dedupeKey: 'job' });
  const keyed = seed('確認依頼', { dedupeKey: 'job' });
  const info = seed(newer.id, { kind: 'info', dedupeKey: 'job' });
  const file = ledgerFile(home);
  writeLedger(file, [{ sessionId: 'abcdef12-rest', ts, status: 'stalled', nextKim: '判断' }]);

  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ORGIAST_HOME: home }, encoding: 'utf8',
  }));
  const read = item => JSON.parse(fs.readFileSync(item.file, 'utf8'));
  const before = new Map([open, older, keyed].map(item => [item.id, fs.readFileSync(item.file, 'utf8')]));
  const preview = { openAsks: 5, groups: 4, superseded: 3, answerInherited: 2, ledgerRowsSynced: 1, backupDir: null };
  assert.deepEqual(run(), preview);
  assert.deepEqual(run('--dry-run'), preview);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')).sort(), ['auto-progress-ledger.jsonl', 'kim-inbox']);
  assert.equal(read(open).status, 'open');
  assert.equal(readLedger(file)[0].kimAnswer, undefined);

  const applied = run('--apply');
  assert.deepEqual(applied, { ...preview, backupDir: applied.backupDir });
  assert.equal(path.dirname(applied.backupDir), path.join(home, '.claude'));
  assert.match(path.basename(applied.backupDir), /^kim-inbox-backup-/);
  assert.equal(fs.readdirSync(applied.backupDir).length, 3);
  for (const [item, target] of [[open, answered], [older, newer], [keyed, dropped]]) {
    const saved = read(item);
    assert.equal(saved.status, 'superseded');
    assert.equal(saved.supersededInto, target.id);
    assert.equal(saved.answer, read(target).answer ?? null);
    assert.equal(saved.answeredAt, read(target).answeredAt ?? null);
    assert.equal(fs.readFileSync(path.join(applied.backupDir, item.id + '.json'), 'utf8'), before.get(item.id));
  }
  assert.equal(readLedger(file)[0].kimAnswer, '進める');
  for (const item of [newer, distinct, info]) assert.equal(read(item).status, 'open');
  assert.deepEqual(run('--apply'), { openAsks: 2, groups: 2, superseded: 0, answerInherited: 0, ledgerRowsSynced: 0, backupDir: null });
});
