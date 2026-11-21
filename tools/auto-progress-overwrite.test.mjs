import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addCheck } from './auto-progress.mjs';
import { ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-overwrite-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, session: 'same-session', check: 'node -e "process.exit(1)"', label: '支払い登録のお願い', deadline: '+24h' };
}
for (const status of ['open', 'scheduled', 'waiting_user']) {
  test(`${status}: 別ラベル拒否は既存の約束を全て示し台帳を変更しない`, t => {
    const options = setup(t);
    const row = addCheck(options);
    writeLedger(ledgerFile(options.home), [{ ...row, status, startWhen: '予約条件', ask: 'お願い全文\n手順' }]);
    const before = fs.readFileSync(ledgerFile(options.home), 'utf8');
    assert.throws(() => addCheck({ ...options, label: '別の約束', probe: () => assert.fail('拒否後は実行しない') }), error => {
      for (const text of [row.label, 'check', '予約条件', 'お願い全文', '--replace', '1つの check']) assert.ok(error.message.includes(text));
      return true;
    });
    assert.equal(fs.readFileSync(ledgerFile(options.home), 'utf8'), before);
    const updated = addCheck({ ...options, check: '更新した判定' });
    assert.equal(updated.check, '更新した判定');
    assert.equal(readLedger(ledgerFile(options.home))[0].status, 'superseded');
  });
}
test('ask の全文を保持し nextKim と promise は古い値を引き継がない（予約も対象）', t => {
  const options = setup(t);
  const old = addCheck(options);
  writeLedger(ledgerFile(options.home), [{ ...old, nextKim: '削除済みのファイルを開く', promise: '古い約束' }]);
  const askFile = path.join(options.home, 'ask.txt');
  const first = '操作'.repeat(100);
  fs.writeFileSync(askFile, first + '\r\n手順の全文');
  const row = addCheck({ ...options, startWhen: 'exit 1', nextClaude: '依頼を届ける', askFile });
  assert.equal(row.status, 'scheduled');
  assert.equal(row.nextKim, first.slice(0, 120));
  assert.equal(row.promise, options.label);
  assert.equal(row.ask, first + '\r\n手順の全文');
  assert.throws(() => addCheck({ ...options, label: '別の予約' }), /--replace/);
});
test('CLI: 別ラベルはexit 2、--replace は明示的に置換し、同ラベル更新も成功', t => {
  const options = setup(t);
  const cli = extra => spawnSync(process.execPath, ['tools/auto-progress.mjs', '--add-check', '--session', options.session, '--check', options.check, '--deadline', '+24h', '--label', '新しい約束', ...extra], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: options.home }, timeout: 20000 });
  addCheck(options);
  assert.equal(cli([]).status, 2);
  const replaced = cli(['--replace']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(cli([]).status, 0);
  assert.deepEqual(readLedger(ledgerFile(options.home)).map(row => row.status), ['superseded', 'superseded', 'open']);
});
