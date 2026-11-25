import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultProbe, runAstraAeCheck } from './astra-ae-integration-check.mjs';

const script = fileURLToPath(new URL('./astra-ae-integration-check.mjs', import.meta.url));
const ids = ['after-effects-installed', 'higgsfield-plugin', 'astra-lane-available', 'node-runtime'];
function injected(statuses = {}) {
  return Object.fromEntries(ids.map((id) => [id, async () => ({ status: statuses[id] || 'pass', evidence: `${id} fixture` })]));
}

test('AE ありは pass', async () => assert.equal((await runAstraAeCheck({ probe: injected() })).results[0].status, 'pass'));
test('AE 無しは fail', async () => assert.equal((await runAstraAeCheck({ probe: injected({ 'after-effects-installed': 'fail' }) })).results[0].status, 'fail'));
test('Higgsfield 痕跡ありは pass', async () => assert.equal((await runAstraAeCheck({ probe: injected() })).results[1].status, 'pass'));
test('Higgsfield 痕跡なしは fail ではなく unknown', async () => assert.equal((await runAstraAeCheck({ probe: injected({ 'higgsfield-plugin': 'unknown' }) })).results[1].status, 'unknown'));
test('required fail は blocked で blockers に入る', async () => {
  const report = await runAstraAeCheck({ probe: injected({ 'after-effects-installed': 'fail' }) });
  assert.equal(report.verdict, 'blocked'); assert.deepEqual(report.blockers, ['after-effects-installed']);
});
test('required unknown は unknown', async () => assert.equal((await runAstraAeCheck({ probe: injected({ 'higgsfield-plugin': 'unknown' }) })).verdict, 'unknown'));
test('optional fail は blocked にしない', async () => {
  const report = await runAstraAeCheck({ probe: injected({ 'astra-lane-available': 'fail' }) });
  assert.equal(report.verdict, 'ready'); assert.deepEqual(report.blockers, []);
});

async function cooldownResult(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-ae-'));
  const file = path.join(dir, 'provider-cooldown.json');
  fs.writeFileSync(file, content);
  const probe = { ...injected(), 'astra-lane-available': defaultProbe['astra-lane-available'] };
  try { return (await runAstraAeCheck({ probe, cooldown: async () => ({ file, state: JSON.parse(await fs.promises.readFile(file, 'utf8')) }) })).results[2]; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('未来の cooldown until は fail', async () => assert.equal((await cooldownResult(JSON.stringify({ 'codex-astra': { until: Date.now() + 60000, reason: 'usage_limit' } }))).status, 'fail'));
test('過去の cooldown until は pass', async () => assert.equal((await cooldownResult(JSON.stringify({ 'codex-astra': { until: Date.now() - 60000 } }))).status, 'pass'));
test('不正 cooldown JSON は unknown', async () => assert.equal((await cooldownResult('{bad json')).status, 'unknown'));

function runChild(status, args) {
  const source = `import { main } from ${JSON.stringify(new URL(`file://${script}`).href)}; const ids=${JSON.stringify(ids)}; const probe=Object.fromEntries(ids.map(id=>[id,async()=>({status:id==='after-effects-installed'?${JSON.stringify(status)}:'pass',evidence:'fixture'})])); await main(${JSON.stringify(args)},{probe});`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' });
}
test('--strict は blocked で exit 1、ready で exit 0', () => {
  assert.equal(runChild('fail', ['--strict']).status, 1);
  assert.equal(runChild('pass', ['--strict']).status, 0);
});
test('--json は単一のパース可能な JSON だけを stdout に出す', () => {
  const child = runChild('pass', ['--json']);
  assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).verdict, 'ready'); assert.equal(child.stderr, '');
});
test('probe 例外は項目単位の unknown になり他項目を壊さない', async () => {
  const probe = injected(); probe['node-runtime'] = async () => { throw new Error('boom'); };
  const report = await runAstraAeCheck({ probe });
  assert.equal(report.results[3].status, 'unknown'); assert.match(report.results[3].evidence, /boom/); assert.equal(report.results[0].status, 'pass');
});
