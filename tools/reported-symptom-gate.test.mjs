import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateReportedSymptomFromRaw as evaluate, configuredMode } from './reported-symptom-gate.mjs';
import { evaluateExternalStateClaimFromRaw } from './external-state-claim-gate.mjs';
const fixtures = JSON.parse(fs.readFileSync(new URL('./reported-symptom-gate.fixtures.json', import.meta.url), 'utf8'));
const human = content => ({ type: 'user', message: { role: 'user', content } });
const use = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const raw = (...entries) => entries.map(e => JSON.stringify(e)).join('\n');
for (const f of fixtures) test(`R1/R3 fixture ${f.name}`, () => {
  const transcriptRaw = raw(human(f.report), use(f.tool.name, f.tool.input));
  assert.equal(evaluate({ text: f.text, transcriptRaw }).decision, f.decision);
  if (['request', 'values'].includes(f.name)) assert.equal(evaluateExternalStateClaimFromRaw({ text: f.text, transcriptRaw }).decision, 'pass');
});
test('R1 requires both marker and current-turn matching vendor, ignoring sidechains', () => {
  const h = human('Vercel のデプロイが失敗しています');
  const q = use('Bash', { command: 'vercel ls' });
  for (const [transcriptRaw, marker, expected] of [
    [raw(h, q), true, 'pass'], [raw(h, q), false, 'block'], [raw(q, h), true, 'block'],
    [raw(h, { ...q, isSidechain: true }), true, 'block'], [raw(h, use('Bash', { command: 'gh run list' })), true, 'block'],
  ]) assert.equal(evaluate({ text: (marker ? '[直接照会: Vercel] ' : '') + '正常です。', transcriptRaw }).decision, expected);
});
test('no reported symptom, sidechain report, tool output and previous turn do not trigger', () => {
  const h = human('Vercel が失敗しています');
  for (const transcriptRaw of ['', raw(h, human('こんにちは')), raw({ ...h, isSidechain: true }), raw(human([{ type: 'tool_result', content: 'Vercel error' }]))])
    assert.equal(evaluate({ text: '正常です。', transcriptRaw }).decision, 'pass');
});
test('unknown named systems fail closed; text-block reports work', () => {
  assert.equal(evaluate({ text: '正常です', transcriptRaw: raw(human([{ type: 'text', text: 'AcmeApp が動かない' }])) }).decision, 'block');
});
test('R3 needs a concrete request in this message, not a promise or past request', () => {
  const transcriptRaw = raw(human('Anthropic Console で支払いエラー'), { type: 'assistant', message: { content: 'スクショを送ってください' } });
  for (const suffix of ['', 'あとで依頼します。', 'スクショは不要です。', '前回スクショを送ってくださいと書いた。'])
    assert.equal(evaluate({ text: 'Console は確認不可です。' + suffix, transcriptRaw }).code, 'UNREACHABLE-EVIDENCE');
  assert.equal(evaluate({ text: 'Console は確認不可です。該当ページの URL を開いて見える値を教えてください。', transcriptRaw }).decision, 'pass');
});
test('warn preserves R1 and R3 diagnostics', () => {
  const old = process.env.ORGIAST_REPORTED_SYMPTOM_GATE;
  try {
    process.env.ORGIAST_REPORTED_SYMPTOM_GATE = 'invalid'; assert.equal(configuredMode(), 'block');
    process.env.ORGIAST_REPORTED_SYMPTOM_GATE = 'warn';
    for (const text of ['問題ありません', 'Console は確認不可です']) {
      const result = evaluate({ text, transcriptRaw: raw(human('Anthropic API error')) });
      assert.equal(result.decision, 'pass'); assert.ok(result.code);
    }
  } finally { if (old === undefined) delete process.env.ORGIAST_REPORTED_SYMPTOM_GATE; else process.env.ORGIAST_REPORTED_SYMPTOM_GATE = old; }
});

test('unknown wording cannot conceal a denial; gate specification is exempt', () => {
  const transcriptRaw = raw(human('Anthropic Billing の支払いが失敗しています'));
  assert.equal(evaluate({ text: '未確認ですが残高は枯渇していません。', transcriptRaw }).decision, 'block');
  assert.equal(evaluateExternalStateClaimFromRaw({ text: '未確認ですが残高は枯渇していません。', transcriptRaw }).decision, 'block');
  assert.equal(evaluate({ text: 'reported-symptom-gate の仕様は「正常です」を block することです。', transcriptRaw }).decision, 'pass');
});
