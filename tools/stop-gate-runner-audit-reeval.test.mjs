// 先行 gate が regex-blocked で第2段監査を飛ばした後に demote で block が 0 件になっても、
// 手渡しが無検査で通らないことを固定する（handoff-audit:2ddd67033c25e70a / f94ee7a）。
// 監査 provider は注入した偽 ask で置き換え、外部呼び出しは行わない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from './stop-gate-runner.mjs';

// 「確認してください」= user-burden-gate（FORM_GATE）が block するが、classifyHandoff は manual-steps にしない。
// 末尾の定型行で next-action-gate を pass させ、第2段だけが残る状況を作る。
const text = 'DBの値を確認してください。\n\n次に kim がすること: なし';

const blockReply = JSON.stringify({
  verdict: 'block',
  violations: [{ rule: 3, quote: 'DBの値を確認してください。', fix: 'Claude 側で DB を直接照会する' }],
  learned: [],
});
const passReply = JSON.stringify({ verdict: 'pass', violations: [], learned: [] });

function auditOptions(home, ask) {
  return {
    home,
    ask,
    mode: 'block',
    // reportGate / provisionKeys による外部送信・取得を止める。テストは端末内で完結させる。
    policyOptions: { notify: async () => ({ delivered: 'suppressed' }), refresh: async () => {} },
  };
}

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-reeval-'));
  const prev = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function ledgerRows(home) {
  const file = path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl');
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
}

test('demoteで先行gateが0件になっても第2段監査がblockを返せば素通りしない', async t => {
  const home = withHome(t);
  let calls = 0;
  const result = await run({ session_id: 'reeval-block', assistant_text: text }, { raw: '', humanText: '' }, auditOptions(home, async () => { calls++; return blockReply; }));
  // 第1段は regex-blocked で provider を呼ばず、第2段の再評価だけが provider を呼ぶ。
  assert.equal(calls, 1);
  assert.equal(result.decision, 'block');
  assert.ok(result.record.blockedBy.includes('handoff-audit-gate'), JSON.stringify(result.record.blockedBy));
  assert.ok(result.record.demoted.includes('user-burden-gate'), JSON.stringify(result.record.demoted));
  assert.match(result.reason, /HANDOFF-AUDIT/);
});

test('第2段監査がpassなら通す（blockを握りつぶさない）', async t => {
  const home = withHome(t);
  const result = await run({ session_id: 'reeval-pass', assistant_text: text }, { raw: '', humanText: '' }, auditOptions(home, async () => passReply));
  assert.notEqual(result.decision, 'block');
  assert.deepEqual(result.record.blockedBy, []);
  const rows = ledgerRows(home);
  assert.equal(rows.at(-1).verdict, 'pass');
});
