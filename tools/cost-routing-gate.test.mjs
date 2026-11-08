import test from 'node:test'; import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process'; import { classifyRequest, classifyWithJev } from './cost-routing-gate.mjs';
const cases = [
 ['どう思う？','consult'],['なぜですか','consult'],['教えて','consult'],
 ['実装して','implement'],['バグをfixして','implement'],['どう直して実装する？','implement'],
 ['1行だけ変えて','edit-small'],['typo','edit-small'],['名前を変えて','edit-small'],
 ['テストして','verify'],['レビューして','verify'],['通るか見て','verify'],
 ['10件分類','bulk'],['全件要約','bulk'],['消費者向け文章を作成','bulk'],
 ['Driveを確認','mcp'],['500件を今すぐ分類して','bulk'],['Discord bot を実装して','implement'],['Drive連携のhook作って','implement'],['DiscordへDM','mcp'],['メール送信','mcp'],
 ['アーキテクチャの方針','design'],['複数案のトレードオフ','design'],['設計してから実装して','design'],
 ['Driveの20件を修正','mcp'],['全件を実装','bulk'],['[レーン固定: verify] 実装して','verify'],
];
for (const [prompt, lane] of cases) test(`${prompt} => ${lane}`, () => assert.equal(classifyRequest(prompt).lane, lane));
test('hook先頭行と状態保存', () => { const input = JSON.stringify({ prompt:'実装して', session_id:'s1' }); const run=spawnSync(process.execPath,['tools/cost-routing-gate.mjs'],{input,encoding:'utf8',env:{...process.env,ORGIAST_JEV_ROUTING:'0',ORGIAST_HOME:'/tmp/cost-routing-gate-test'}}); const out=JSON.parse(run.stdout); assert.match(out.hookSpecificOutput.additionalContext,/^\[実行レーン\]/); });

test('userへの操作案内では節約圧を除き調査優先を保存する', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-burden-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [prompt, userFacing] of [['この画面で次どこ押せばいい？ [Image #1]', true], ['hook を実装して', false]]) {
    const result = spawnSync(process.execPath, ['tools/cost-routing-gate.mjs'], { input: JSON.stringify({ prompt, session_id: 's' }), encoding: 'utf8', env: { ...process.env, ORGIAST_JEV_ROUTING: '0', ORGIAST_HOME: home } });
    assert.equal(result.status, 0, result.stderr); const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    if (userFacing) { assert.match(ctx, /^\[調査優先\]/); assert.doesNotMatch(ctx, /3 ターン以内|Read\/Grep 数回/); } else assert.match(ctx, /3 ターン以内/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'session-lane', 's.json'))).userFacing, userFacing);
  }
});

test('Jev の信頼度0.7以上を採用し助言も再計算', async t => {
  const prior = process.env.ORGIAST_JEV_ROUTING; delete process.env.ORGIAST_JEV_ROUTING;
  t.after(() => { if (prior === undefined) delete process.env.ORGIAST_JEV_ROUTING; else process.env.ORGIAST_JEV_ROUTING = prior; });
  const result = await classifyWithJev('確認して', { askJevImpl: async request => {
    assert.equal(request.timeoutMs, 3000);
    assert.deepEqual(Object.keys(request.questions.lane.criteria), ['consult', 'implement', 'edit-small', 'verify', 'bulk', 'mcp', 'design']);
    return { ok: true, answers: { lane: { type: 'choice', choice: 'implement', confidence: 0.7 } } };
  } });
  assert.equal(result.lane, 'implement'); assert.match(result.primary, /codex-do/); assert.equal(result.decision, 'jev(conf 0.70)');
  for (const answer of [{ ok: false }, { ok: true, answers: { lane: { type: 'choice', choice: 'bulk', confidence: 0.69 } } }, { ok: true, answers: { lane: { type: 'choice', choice: 'invalid', confidence: 1 } } }]) {
    const fallback = await classifyWithJev('確認して', { askJevImpl: async () => answer });
    assert.deepEqual(fallback, { ...classifyRequest('確認して'), decision: 'rule' });
  }
  assert.equal((await classifyWithJev('確認して', { askJevImpl: async () => { throw new Error('offline'); } })).decision, 'rule');
  const never = async () => { assert.fail('must not call Jev'); };
  assert.equal((await classifyWithJev('[レーン固定: verify] 実装して', { askJevImpl: never })).lane, 'verify');
  process.env.ORGIAST_JEV_ROUTING = '0';
  assert.equal((await classifyWithJev('実装して', { askJevImpl: never })).decision, 'rule');
});
