import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuleComplianceMail, parseRuleComplianceMail, latestComplianceByPc,
  rulesRegistry, measuredRules, COMPLIANCE_DAYS, COMPLIANCE_WHY_LIMIT, RULE_COMPLIANCE_TAG } from './rule-compliance-mail.mjs';

const rule = measuredRules[0];
function report(at = '2026-10-18T03:00:00Z', pc = 'test-PC') {
  return { pc, at, days: COMPLIANCE_DAYS, rulesHead: 'abc', rules: {
    [rule.id]: { applicable: 10, violation: 7, unmeasured: 1, examples: [{ excerpt: 'PRIVATE' }] }
  }, enforcement: { [rule.id]: { mode: 'block', reason: 'PRIVATE' } } };
}
test('build/parse round trip preserves only counts and modes, registry short IDs and report tag', () => {
  const mail = buildRuleComplianceMail(report());
  const parsed = parseRuleComplianceMail(mail);
  assert.equal(parsed.pc, 'test-PC');
  assert.deepEqual(parsed.rules[rule.id], { applicable: 10, violation: 7, rate: 0.7, unmeasured: 1, mode: 'block' });
  assert.equal(parsed.enforcementModes[rule.id], 'block');
  assert.ok(mail.why.includes(`${RULE_COMPLIANCE_TAG} test-PC ${rule.short} 70%(7/10,block)`));
  assert.doesNotMatch(mail.body, /PRIVATE|examples|reason/);
  assert.equal(new Set(rulesRegistry.rules.map(r => r.short)).size, rulesRegistry.rules.length);
});
test('why is capped at 200 characters and JSON remains intact', () => {
  const mail = buildRuleComplianceMail(report(undefined, '長'.repeat(COMPLIANCE_WHY_LIMIT * 2)));
  assert.equal(mail.why.length, COMPLIANCE_WHY_LIMIT);
  assert.equal(parseRuleComplianceMail(mail).pc.length, COMPLIANCE_WHY_LIMIT * 2);
});
test('latest uses timestamps regardless of input order and timezone', () => {
  const old = parseRuleComplianceMail(buildRuleComplianceMail(report('2026-10-17T23:00:00Z')));
  const newest = parseRuleComplianceMail(buildRuleComplianceMail(report('2026-10-18T09:00:00+09:00')));
  const other = parseRuleComplianceMail(buildRuleComplianceMail(report(undefined, 'second-PC')));
  assert.deepEqual(latestComplianceByPc([newest, old, other]), [newest, other]);
});
test('malformed, mismatched sender and invalid counts do not provide evidence; rates recomputed', () => {
  const mail = buildRuleComplianceMail(report());
  assert.equal(parseRuleComplianceMail({ ...mail, from: 'different-PC' }), null);
  assert.equal(parseRuleComplianceMail({ ...mail, body: '{' }), null);
  assert.equal(parseRuleComplianceMail({ ...mail, why: '' }), null);
  const body = JSON.parse(mail.body);
  body.rules[rule.id].rate = 0;
  assert.equal(parseRuleComplianceMail({ ...mail, body: JSON.stringify(body) }).rules[rule.id].rate, 0.7);
  body.rules[rule.id].violation = -1;
  assert.equal(parseRuleComplianceMail({ ...mail, body: JSON.stringify(body) }), null);
});
