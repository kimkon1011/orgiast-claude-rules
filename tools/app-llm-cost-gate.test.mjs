import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const hook = path.resolve('tools/app-llm-cost-gate.mjs');
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cost-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.github/workflows'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'scripts'));
  fs.writeFileSync(path.join(cwd, '.github/workflows/batch.yml'), 'ANTHROPIC_API_KEY');
  fs.writeFileSync(path.join(cwd, 'scripts/batch.ts'), 'GEMINI_API_KEY');
  const transcript_path = path.join(cwd, 'transcript.jsonl');
  const say = text => fs.writeFileSync(transcript_path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  say('Starting batch');
  const run = (tool_name, tool_input, env = {}) => {
    const result = spawnSync(process.execPath, [hook], { cwd, input: JSON.stringify({ tool_name, tool_input, cwd, transcript_path }), encoding: 'utf8', env: { ...process.env, APP_LLM_COST_GATE: '', ...env } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : undefined;
  };
  return { cwd, say, run };
}
const edit = { file_path: 'app.ts', new_string: 'new Anthropic(', old_string: '' };
for (const marker of ['@anthropic-ai/sdk', 'new Anthropic(', 'api.anthropic.com', 'anthropic.messages.create', 'client.messages.create', 'web_search_20']) {
  test(`new provider marker blocked: ${marker}`, t => assert.equal(fixture(t).run('Edit', { ...edit, new_string: marker }), 'deny'));
}
test('reason naming 3 other AIs passes', t => assert.equal(fixture(t).run('Edit', { ...edit, new_string: '// LLM-PROVIDER-REASON: Gemini 一致1/3, Perplexity 一致2/5, Grok 一致1/5 で品質不足\nnew Anthropic(' }), undefined));
test('reason naming only 1 other AI is blocked', t => assert.equal(fixture(t).run('Edit', { ...edit, new_string: '// LLM-PROVIDER-REASON: Gemini で品質不足\nnew Anthropic(' }), 'deny'));
test('reason without other AI names is blocked', t => assert.equal(fixture(t).run('Edit', { ...edit, new_string: '// LLM-PROVIDER-REASON: required feature\nnew Anthropic(' }), 'deny'));
test('same AI repeated does not count as 3', t => assert.equal(fixture(t).run('Edit', { ...edit, new_string: '// LLM-PROVIDER-REASON: Gemini Flash, Gemini Pro, gemini 2段\nnew Anthropic(' }), 'deny'));
test('reason in existing file passes', t => { const f = fixture(t); fs.writeFileSync(path.join(f.cwd, 'app.ts'), '// LLM-PROVIDER-REASON: Gemini 一致1/3, Perplexity 一致2/5, Grok 一致1/5 で品質不足'); assert.equal(f.run('Edit', edit), undefined); });
for (const file_path of ['orgiast-claude-rules/tools/a.mjs', '.claude/a.js', 'app.test.ts', 'README.md']) {
  test(`excluded ${file_path}`, t => assert.equal(fixture(t).run('Edit', { ...edit, file_path }), undefined));
}
test('existing marker passes', t => assert.equal(fixture(t).run('Edit', { ...edit, old_string: 'new Anthropic(' }), undefined));
test('different newly added marker blocked', t => assert.equal(fixture(t).run('Edit', { ...edit, old_string: '@anthropic-ai/sdk' }), 'deny'));
test('Write and MultiEdit checked', t => { const f = fixture(t); assert.equal(f.run('Write', { file_path: 'app.ts', content: edit.new_string }), 'deny'); assert.equal(f.run('MultiEdit', { file_path: 'app.ts', edits: [{ old_string: '', new_string: edit.new_string }] }), 'deny'); });
test('workflow limit 1000 blocked', t => assert.equal(fixture(t).run('Bash', { command: 'gh workflow run batch.yml -f limit=1000' }), 'deny'));
test('valid measured estimate passes', t => { const f = fixture(t); f.say('[COST-ESTIMATE: 1件 $0.01(3件実測)×1000件=$10 / 上限$20]'); assert.equal(f.run('Bash', { command: 'gh workflow run batch.yml -f limit=1000' }), undefined); });
for (const [label, text] of [
  ['over budget', '1件 $1(3件実測)×1000件=$1000 / 上限$20'],
  ['wrong count', '1件 $1(3件実測)×100件=$100 / 上限$200'],
  ['wrong arithmetic', '1件 $1(3件実測)×1000件=$10 / 上限$20'],
  ['sample too large', '1件 $0.01(11件実測)×1000件=$10 / 上限$20'],
]) test(label, t => { const f = fixture(t); f.say(`[COST-ESTIMATE: ${text}]`); assert.equal(f.run('Bash', { command: 'gh workflow run batch.yml -f count=1000' }), 'deny'); });
test('small batch passes', t => assert.equal(fixture(t).run('Bash', { command: 'gh workflow run batch.yml -f limit=5' }), undefined));
test('workflow without paid key passes', t => { const f = fixture(t); fs.writeFileSync(path.join(f.cwd, '.github/workflows/batch.yml'), 'echo hello'); assert.equal(f.run('Bash', { command: 'gh workflow run batch.yml -f limit=1000' }), undefined); });
for (const command of ['npx tsx scripts/batch.ts 1000', 'node scripts/batch.ts --mode collect 1000', 'gh workflow run batch.yml --field=count=1000']) test(command, t => assert.equal(fixture(t).run('Bash', { command }), 'deny'));
test('old estimate does not authorize latest message', t => { const f = fixture(t); f.say('[COST-ESTIMATE: 1件 $0.01(3件実測)×1000件=$10 / 上限$20]'); fs.appendFileSync(path.join(f.cwd, 'transcript.jsonl'), JSON.stringify({ type: 'assistant', message: { content: 'New plan' } })); assert.equal(f.run('Bash', { command: 'node scripts/batch.ts 1000' }), 'deny'); });
test('off bypasses', t => assert.equal(fixture(t).run('Edit', edit, { APP_LLM_COST_GATE: 'off' }), undefined));
test('malformed input fails open', () => { const r = spawnSync(process.execPath, [hook], { input: '{oops', encoding: 'utf8' }); assert.equal(r.status, 0); assert.equal(r.stdout, ''); });
test('unreadable workflow fails open', t => assert.equal(fixture(t).run('Bash', { command: 'gh workflow run absent.yml -f count=1000' }), undefined));
test('5-sample estimate passes', t => { const f = fixture(t); f.say('[COST-ESTIMATE: 1件 $0.017(5件実測)×246件=$4.182 / 上限$5]'); assert.equal(f.run('Bash', { command: 'gh workflow run batch.yml -f limit=246' }), undefined); });
