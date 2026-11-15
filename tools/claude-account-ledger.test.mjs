import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLedger, serverProjection, isContractedLocal, membersByPc } from './claude-account-ledger.mjs';

test('正本は証拠のある Claude 席と組織を含む', () => {
  const ledger = loadLedger();
  assert.equal(ledger.version, 1);
  for (const email of ['cr@orgiast.jp', 'kim@orgiast.jp', 'nishi@orgiast.jp', 'seisaku-team@orgiast.jp', 'm.kanau@orgiast.jp', 'genbateam.toho@gmail.com']) {
    assert.ok(ledger.members.some(member => member.email === email), `必須の席: ${email}`);
  }
  assert.ok(ledger.contractedOrgUuids.includes('07b2296b-cf32-43b5-993e-be47884b3fda'));
  for (const uuid of ledger.contractedOrgUuids) assert.match(uuid, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  for (const member of ledger.members) {
    for (const key of ['name', 'email', 'claudeEmails', 'discordId', 'pcs', 'status', 'retiredOn']) {
      assert.ok(Object.hasOwn(member, key), `${member.email}: ${key}`);
    }
    assert.equal(typeof member.name, 'string');
    assert.ok(member.name.trim());
    assert.match(member.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    assert.ok(['active', 'retired', 'pending'].includes(member.status));
    assert.ok(Array.isArray(member.claudeEmails));
    for (const email of member.claudeEmails) assert.match(email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    assert.ok(Array.isArray(member.pcs));
    for (const pc of member.pcs) assert.ok(typeof pc === 'string' && pc.trim());
    assert.ok(member.discordId === null || /^\d+$/.test(member.discordId));
    assert.ok(member.retiredOn === null || /^\d{4}-\d{2}-\d{2}$/.test(member.retiredOn));
  }
  const active = new Set(), retired = new Set();
  for (const member of ledger.members) {
    const target = member.status === 'active' ? active : member.status === 'retired' ? retired : null;
    for (const email of [member.email, ...member.claudeEmails]) target?.add(email.trim().toLowerCase());
  }
  for (const email of retired) active.delete(email);
  assert.deepEqual(serverProjection(ledger), {
    contractedOrgUuids: [...new Set(ledger.contractedOrgUuids)].sort(),
    activeEmails: [...active].sort(), retiredEmails: [...retired].sort(),
  });
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
  const extended = { version: 1, contractedOrgUuids: ['org'], members: [{ email: 'test@example.com', status: 'active', note: '追記' }], unresolvedSeats: ['未確定'] };
  fs.writeFileSync(file, JSON.stringify(extended));
  assert.deepEqual(loadLedger(file), extended);
  fs.writeFileSync(file, '{"version":2}');
  assert.throws(() => loadLedger(file));
});
