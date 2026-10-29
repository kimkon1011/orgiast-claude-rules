import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLedger, serverProjection, isContractedLocal, membersByPc } from './claude-account-ledger.mjs';

test('正本は証拠のある Claude 席と組織を含む', () => {
  const ledger = loadLedger();
  assert.equal(ledger.version, 1);
  assert.deepEqual(serverProjection(ledger).activeEmails, ['cr@orgiast.jp', 'kim@orgiast.jp', 'nishi@orgiast.jp', 'seisaku-team@orgiast.jp']);
  assert.deepEqual(ledger.contractedOrgUuids, ['07b2296b-cf32-43b5-993e-be47884b3fda']);
  assert.equal(membersByPc(ledger)['nishi-PC'][0].email, 'nishi@orgiast.jp');
});

test('退職者と重複 alias は active に入らず、小文字化される', () => {
  const ledger = { contractedOrgUuids: ['org'], members: [
    { email: 'ACTIVE@EXAMPLE.COM', claudeEmails: ['Alias@Example.com', 'retired@example.com'], status: 'active', pcs: ['pc'] },
    { email: 'RETIRED@EXAMPLE.COM', claudeEmails: ['Old@Example.com'], status: 'retired', pcs: ['pc'] },
    { email: 'unknown@example.com', status: 'pending' },
  ] };
  assert.deepEqual(serverProjection(ledger), { contractedOrgUuids: ['org'], activeEmails: ['active@example.com', 'alias@example.com'], retiredEmails: ['old@example.com', 'retired@example.com'] });
  assert.equal(isContractedLocal('ALIAS@example.com', ledger), true);
  assert.equal(isContractedLocal('retired@example.com', ledger), false);
  assert.equal(isContractedLocal(undefined, ledger), false);
  assert.equal(membersByPc(ledger).pc.length, 2);
});

test('loadLedger は一時ファイルを読み、壊れた形式は拒否', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.json');
  fs.writeFileSync(file, JSON.stringify(loadLedger()));
  assert.equal(loadLedger(file).version, 1);
  fs.writeFileSync(file, '{"version":2}');
  assert.throws(() => loadLedger(file));
});
