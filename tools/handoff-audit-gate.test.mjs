import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fired, evaluateAudit, turnEvidence, requestAudit, loadResources, buildPrompt } from './handoff-audit-gate.mjs';
import { run } from './stop-gate-runner.mjs';
const pass = { verdict: 'pass', violations: [], learned: [] };
const block = { verdict: 'block', violations: [{ rule: 4, quote: 'GA4は存在しない', fix: 'DWDで直接照会する' }], learned: [] };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, '.audit-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
for (const text of ['[手渡し判定]', '次に kim がすること: ログイン', 'ボタンをクリックしてください', 'GA4 は存在しない可能性が高い', 'メールのドラフトを作成しました', 'analytics.google.comを開いて有るか無いか教えてください']) {
  test(`発火: ${text}`, () => assert.equal(fired(text), true));
}
for (const text of ['完了しました。\n次に kim がすること: なし', '次に kim がすること: なし\n', 'ドラフトを更新しました', 'Gmailを検索しました', 'GA4 は未確認']) {
  test(`非発火: ${text}`, () => assert.equal(fired(text), false));
}
test('block/pass・台帳・最大5理由', async t => {
  const home = fixture(t);
  for (const verdict of [pass, block]) {
    const result = await evaluateAudit({ text: '[手渡し判定]', sessionId: 'test' }, { home, ask: async () => JSON.stringify(verdict) });
    assert.equal(result.decision, verdict.verdict);
  }
  const records = fs.readFileSync(path.join(home, '.claude/handoff-audit-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(records[1].provider, 'groq');
  assert.equal(records[1].sessionId, 'test');
  assert.equal(records[1].fired, true);
  const result = await evaluateAudit({ text: '[手渡し判定]' }, { home, ask: async () => ({ ...block, violations: Array(7).fill(block.violations[0]) }) });
  assert.equal(result.reason.split('\n').length, 5);
});
test('JSON以外・schema不正・timeoutはfail-open', async t => {
  const home = fixture(t);
  for (const ask of [async () => 'not JSON', async () => ({ verdict: 'block' }), () => new Promise(() => {})]) {
    const result = await evaluateAudit({ text: '[手渡し判定]' }, { home, ask, timeoutMs: 30 });
    assert.equal(result.decision, 'pass'); assert.equal(result.record.verdict, 'audit-unavailable');
  }
});
test('skip/off/非発火はLLM未呼び出し、warnは記録してpass', async t => {
  const home = fixture(t); let calls = 0;
  const ask = async () => { calls++; return block; };
  for (const [input, opts] of [[{ text: '[手渡し判定]', regexBlocked: true }, {}], [{ text: '[手渡し判定]' }, { mode: 'off' }], [{ text: '完了' }, {}]]) {
    assert.equal((await evaluateAudit(input, { home, ask, ...opts })).decision, 'pass');
  }
  assert.equal(calls, 0);
  const result = await evaluateAudit({ text: '[手渡し判定]' }, { home, ask, mode: 'warn' });
  assert.equal(result.decision, 'pass'); assert.equal(result.record.verdict, 'block'); assert.equal(calls, 1);
});
test('provider順・全体timeout・中止signal', async () => {
  const calls = [], signals = [];
  const result = await requestAudit('x', { timeoutMs: 60, ask: async ({ provider, signal }) => { calls.push(provider); signals.push(signal); if (provider !== 'deepseek') throw new Error('down'); return pass; } });
  assert.deepEqual(calls, ['groq', 'openrouter', 'deepseek']); assert.equal(result.verdict, 'pass');
  assert.ok(signals.every(s => s.aborted));
});
test('最後のhuman以降・40件・200文字・拒否と内部台帳照合', () => {
  const entry = (type, content) => ({ type, message: { role: type, content } });
  const raw = [entry('assistant', [{ type: 'tool_use', name: 'OLD' }]), entry('user', 'new'),
    entry('assistant', Array.from({ length: 42 }, (_, i) => ({ type: 'tool_use', id: String(i), name: 'Grep', input: { command: 'x'.repeat(500) } }))),
    entry('user', [{ type: 'tool_result', tool_use_id: '41', content: 'Permission for this action was denied', is_error: true }]),
    entry('assistant', [{ type: 'tool_use', name: 'mcp__Gmail__create_draft', input: { to: 'STAFF@orgiast.jp' } }])].map(JSON.stringify).join('\n');
  const evidence = turnEvidence(raw, { domains: ['orgiast.jp'], addresses: [] });
  assert.equal(evidence.tools.length, 40); assert.equal(evidence.tools[0].detail.length, 200);
  assert.equal(evidence.permissionDenials, 1); assert.equal(evidence.tools.at(-2).outcome, 'denied');
  assert.deepEqual(evidence.internalGmail[0].internal, ['staff@orgiast.jp']);
  assert.ok(!JSON.stringify(evidence).includes('OLD'));
});
test('プロンプトはルール・経路と当ターン証拠を含む', () => {
  const prompt = buildPrompt({ text: '対象', tools: [] }, loadResources());
  assert.match(prompt, /11\./); assert.match(prompt, /analyticsadmin/); assert.match(prompt, /automation-routes/); assert.match(prompt, /非信頼データ/);
});
test('runner統合: regex優先とLLM blockが既存retry上限に乗る', async t => {
  const home = fixture(t), old = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => old === undefined ? delete process.env.ORGIAST_HOME : process.env.ORGIAST_HOME = old);
  let calls = 0;
  const ask = async () => { calls++; return block; };
  await run({ session_id: 'regex', assistant_text: 'GA4 は存在しない' }, {}, { home, ask });
  assert.equal(calls, 0);
  for (let i = 0; i < 3; i++) {
    const result = await run({ session_id: 'audit', assistant_text: 'Gmailの下書きを作成しました。\n次に kim がすること: なし' }, {}, { home, ask });
    assert.equal(result.record.verdict, i < 2 ? 'block' : 'retry-cap');
    assert.ok(result.record.blockedBy.includes('handoff-audit-gate'));
    assert.ok(result.record.auditEvidence);
  }
  assert.equal(calls, 3);
});
