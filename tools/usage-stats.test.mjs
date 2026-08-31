import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { calculateDelegation, calculateLinesDelegation, classifyBashCommand, collectBashProfile, collectClaudeCostStats, collectClaudeLines, collectClaudeStats, collectCodexOutput, collectLandedLines, collectLedger, collectTurnStats, countPatchLines, estimateSpecAuthoringTokens, extractInlineProgram, formatBashProfile, parseCacheStats, resetParseCacheForTests } from './usage-stats.mjs';

function fixture() { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stats-')), dir = path.join(home, '.claude', 'projects', 'p'); fs.mkdirSync(dir, { recursive: true }); return { home, file: path.join(dir, 'session.jsonl') }; }
test('sessions uses row timestamps and splits main/sub/model', () => { const { home, file } = fixture(), now = Date.parse('2026-08-23T00:00:00Z'); const row = (timestamp, output_tokens, model, isSidechain = false) => JSON.stringify({ timestamp, isSidechain, message: { model, usage: { output_tokens }, content: [{ type: 'text', text: 'abc' }] } }); fs.writeFileSync(file, [row('2026-08-22T00:00:00Z', 100, 'claude-opus'), row('2026-08-21T00:00:00Z', 40, 'claude-sonnet', true), row('2026-07-01T00:00:00Z', 9999, 'claude-opus')].join('\n')); fs.utimesSync(file, new Date(now), new Date(now)); const x = collectClaudeStats({ home, days: 7, now }); assert.deepEqual(x.totals, { outputTokens: 140, main: 100, sub: 40 }); assert.deepEqual(x.byModel, { opus: 100, sonnet: 40 }); });
test('parse cache hits unchanged files and reparses size/mtime changes', () => {
  const { home, file } = fixture(), now = Date.parse('2026-08-23T00:00:00Z');
  const row = (n) => JSON.stringify({ timestamp: new Date(now).toISOString(), message: { model: 'opus', usage: { output_tokens: n }, content: [] } });
  fs.writeFileSync(file, row(3)); fs.utimesSync(file, new Date(now), new Date(now)); resetParseCacheForTests();
  assert.equal(collectClaudeStats({ home, now }).totals.outputTokens, 3);
  resetParseCacheForTests(); assert.equal(collectClaudeStats({ home, now }).totals.outputTokens, 3); assert.deepEqual(parseCacheStats(home), { hits: 1, misses: 0 });
  fs.writeFileSync(file, `${row(3)}\n${row(5)}`); fs.utimesSync(file, new Date(now + 1000), new Date(now + 1000));
  resetParseCacheForTests();
  assert.equal(collectClaudeStats({ home, now }).totals.outputTokens, 8); assert.equal(parseCacheStats(home).misses, 1);
});
test('corrupt parse cache is ignored and rebuilt', () => {
  const { home, file } = fixture(), now = Date.now(), cache = path.join(home, '.claude', 'cost-loop-parse-cache.json');
  fs.writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), message: { model: 'opus', usage: { output_tokens: 7 }, content: [] } }));
  fs.writeFileSync(cache, '{broken'); resetParseCacheForTests();
  assert.equal(collectClaudeStats({ home, now }).totals.outputTokens, 7); assert.doesNotThrow(() => JSON.parse(fs.readFileSync(cache, 'utf8')));
});
test('blocks assigns visible estimates and the output remainder to thinking', () => { const { home, file } = fixture(), now = Date.now(); fs.writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), message: { model: 'opus', usage: { output_tokens: 100 }, content: [{ type: 'text', text: '12345' }, { type: 'tool_use', name: 'Bash', input: '12345' }] } })); const b = collectClaudeStats({ home, now }).blocks, textEstimate = 5 / 1.8, toolEstimate = JSON.stringify('12345').length / 3.4; assert.ok(Math.abs(b.text - textEstimate) < 1e-9); assert.ok(Math.abs(b.tool_use - toolEstimate) < 1e-9); assert.ok(Math.abs(b.thinking - (100 - textEstimate - toolEstimate)) < 1e-9); assert.equal(b.tools.Bash, b.tool_use); });
test('blocks assigns empty thinking-only output to thinking', () => { const { home, file } = fixture(), now = Date.now(); fs.writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), message: { model: 'opus', usage: { output_tokens: 100 }, content: [{ type: 'thinking', signature: 'sig' }] } })); const b = collectClaudeStats({ home, now }).blocks; assert.equal(b.thinking, 100); assert.equal(b.text, 0); assert.equal(b.unattributed, 0); });
test('blocks assigns output with empty content to thinking remainder', () => { const { home, file } = fixture(), now = Date.now(); fs.writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), message: { model: 'opus', usage: { output_tokens: 100 }, content: [] } })); const b = collectClaudeStats({ home, now }).blocks; assert.equal(b.unattributed, 0); assert.equal(b.text, 0); assert.equal(b.thinking, 100); });

test('duplicate message records count output once and derive thinking from visible blocks', () => { const { home, file } = fixture(), now = Date.now(), input = { command: 'printf one\\nprintf two' }; const row = (content) => JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'assistant', message: { id: 'msg-duplicate', role: 'assistant', model: 'claude-opus', usage: { output_tokens: 180 }, content } }); fs.writeFileSync(file, [row([{ type: 'thinking', signature: 'sig' }]), row([{ type: 'tool_use', name: 'Bash', input }])].join('\n')); const x = collectClaudeStats({ home, now }), estimate = JSON.stringify(input).length / 3.4; assert.deepEqual(x.totals, { outputTokens: 180, main: 180, sub: 0 }); assert.deepEqual(x.byModel, { opus: 180 }); assert.ok(Math.abs(x.blocks.thinking - (180 - estimate)) < 1e-9); assert.ok(x.blocks.thinking + x.blocks.text + x.blocks.tool_use <= 180); });
test('duplicate message records use the maximum output token value', () => { const { home, file } = fixture(), now = Date.now(); const row = (output_tokens) => JSON.stringify({ timestamp: new Date(now).toISOString(), message: { id: 'msg-max', model: 'opus', usage: { output_tokens }, content: [] } }); fs.writeFileSync(file, [row(100), row(250)].join('\n')); assert.equal(collectClaudeStats({ home, now }).totals.outputTokens, 250); });
test('single message record passes through unchanged', () => { const { home, file } = fixture(), now = Date.now(); fs.writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), message: { id: 'msg-single', model: 'sonnet', usage: { output_tokens: 73 }, content: [] } })); const x = collectClaudeStats({ home, now }); assert.equal(x.totals.outputTokens, 73); assert.equal(x.byModel.sonnet, 73); });
test('authored lines remain additive across split message records', () => { const { home, file } = fixture(), now = Date.now(); const row = (content) => JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'assistant', message: { id: 'msg-lines', role: 'assistant', model: 'opus', usage: { output_tokens: 50 }, content } }); fs.writeFileSync(file, [row([{ type: 'tool_use', name: 'Write', input: { content: 'a\nb' } }]), row([{ type: 'tool_use', name: 'Edit', input: { new_string: 'c\nd\ne' } }])].join('\n')); assert.equal(collectClaudeStats({ home, now }).authoredLines, 5); });
test('cost stats count split message usage once', () => { const { home, file } = fixture(), now = Date.now(); const row = (content) => JSON.stringify({ timestamp: new Date(now).toISOString(), message: { id: 'msg-cost-duplicate', model: 'opus', usage: { output_tokens: 180, input_tokens: 50, cache_read_input_tokens: 900 }, content } }); fs.writeFileSync(file, [row([{ type: 'thinking' }]), row([{ type: 'tool_use', name: 'Bash', input: {} }])].join('\n')); const x = collectClaudeCostStats({ home, now }); assert.equal(x.outputTokens, 180); assert.equal(x.cacheBase, 50); assert.equal(x.cacheRead, 900); });
test('cost stats use maximum values within a message', () => { const { home, file } = fixture(), now = Date.now(); const row = (output_tokens, input_tokens, cache_read_input_tokens, cache_creation_input_tokens) => JSON.stringify({ timestamp: new Date(now).toISOString(), message: { id: 'msg-cost-max', model: 'sonnet', usage: { output_tokens, input_tokens, cache_read_input_tokens, cache_creation_input_tokens }, content: [] } }); fs.writeFileSync(file, [row(100, 80, 700, 20), row(250, 50, 900, 10)].join('\n')); const x = collectClaudeCostStats({ home, now }); assert.equal(x.outputTokens, 250); assert.deepEqual(x.usageByModel.sonnet, { input: 80, cacheRead: 900, cacheWrite: 20, output: 250 }); });
test('cost stats add records without message ids individually', () => { const { home, file } = fixture(), now = Date.now(); const row = (output_tokens) => JSON.stringify({ timestamp: new Date(now).toISOString(), message: { model: 'haiku', usage: { output_tokens, input_tokens: 10 }, content: [] } }); fs.writeFileSync(file, [row(30), row(40)].join('\n')); const x = collectClaudeCostStats({ home, now }); assert.equal(x.outputTokens, 70); assert.equal(x.cacheBase, 20); assert.equal(x.byModel.haiku, 70); });
test('turns combines split records by message id', () => { const { home, file } = fixture(), now = Date.now(), row = (name, input) => JSON.stringify({ timestamp: new Date(now).toISOString(), message: { id: 'split', model: 'claude-opus', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', name, input }] } }); fs.writeFileSync(file, [row('Read', { file_path: 'a' }), row('Grep', { pattern: 'x' })].join('\n')); const x = collectTurnStats({ home, now }); assert.equal(x.responses, 1); assert.deepEqual(x.byToolCount, { 2: 1 }); assert.equal(x.batchedResponses, 1); });
test('turns records a read-only streak before a write', () => { const { home, file } = fixture(), now = Date.now(), row = (id, name, input = {}) => JSON.stringify({ timestamp: new Date(now + Number(id)).toISOString(), message: { id, model: 'opus', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', name, input }] } }); fs.writeFileSync(file, [row('1', 'Read'), row('2', 'Grep'), row('3', 'Bash', { command: 'git status --short' }), row('4', 'Bash', { command: 'echo x > f' })].join('\n')); assert.deepEqual(collectTurnStats({ home, now }).investigationStreaks, [3]); });
test('bash profile classifies commands and sorts top by chars', () => {
  const { home, file } = fixture(), now = Date.parse('2026-08-23T00:00:00Z');
  const blocks = [
    ['Bash', "node -e \"console.log('this is the longest inline program')\""],
    ['PowerShell', 'llm-ask --provider groq task.md'],
    ['Bash', 'git status --short'],
    ['Bash', 'sed -n 1,20p README.md'],
    ['PowerShell', 'Write-Output hello'],
  ].map(([name, command]) => ({ type: 'tool_use', name, input: { command } }));
  const rows = [
    { timestamp: new Date(now).toISOString(), type: 'assistant', message: { role: 'assistant', content: blocks } },
    { timestamp: '2026-07-01T00:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat old' } }] } },
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  const result = collectBashProfile({ home, days: 7, now });
  assert.equal(result.totalCalls, 5);
  assert.deepEqual(Object.fromEntries(Object.entries(result.byCategory).map(([category, stats]) => [category, stats.calls])), { 'inline-program': 1, 'spec-authoring': 0, delegated: 1, git: 1, 'read-only': 1, other: 1 });
  assert.equal(result.totalChars, blocks.reduce((sum, block) => sum + block.input.command.length, 0));
  assert.ok(Math.abs(Object.values(result.byCategory).reduce((sum, stats) => sum + stats.pct, 0) - 100) < 1e-9);
  assert.deepEqual(result.top.map((item) => item.chars), [...result.top.map((item) => item.chars)].sort((a, b) => b - a));
  assert.equal(result.top[0].category, 'inline-program');
});
test('bash classifier distinguishes authored specs from inline programs', () => {
  for (const delimiter of ["<<'SPEC'", "<<'PY'", "<<'SPEC_EOF'"]) assert.equal(classifyBashCommand(`cat > spec.md ${delimiter}\ntext`), 'spec-authoring');
  assert.equal(classifyBashCommand('cat > spec.md <<EOF\nrequirements\nEOF'), 'spec-authoring');
  assert.equal(classifyBashCommand('python - <<PY\nprint(1)\nPY'), 'inline-program');
  assert.equal(classifyBashCommand('cat > spec.md <<EOF\ntext\nEOF && python - <<PY\nprint(1)\nPY'), 'inline-program');
  assert.equal(classifyBashCommand('python - <<PY\nprint(1)\nPY && node tools/codex-do.mjs task'), 'delegated');
  assert.match(formatBashProfile({ days: 1, totalCalls: 0, totalChars: 0, byCategory: { 'inline-program': { calls: 0, chars: 12, pct: 25 }, 'spec-authoring': { calls: 0, chars: 36, pct: 75 } }, top: [] }), /waste \(inline-program\): 12 chars \(25\.0%\)[\s\S]*delegation preparation \(spec-authoring\): 36 chars \(75\.0%\)/);
});
test('ledger uses t and status ok', () => { const { home } = fixture(), now = Date.now(); fs.writeFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), [JSON.stringify({ t: new Date(now).toISOString(), provider: 'groq', status: 'ok', in: 3, out: 5 }), JSON.stringify({ t: new Date(now).toISOString(), provider: 'groq', status: 'error', out: 2 }), JSON.stringify({ t: '2020-01-01T00:00:00Z', provider: 'groq', status: 'ok', out: 99 })].join('\n')); const x = collectLedger({ home, now }); assert.deepEqual(x.totals, { calls: 2, success: 1, failure: 1, outputTokens: 7 }); });
test('delegation counts sonnet and haiku in numerator', () => { const x = calculateDelegation({ codexOut: 10, execOut: 5, byModel: { sonnet: 20, haiku: 5, opus: 40, fable: 10, default: 10 } }); assert.equal(x.delegated, 40); assert.equal(x.supervisorOut, 60); assert.equal(x.delegRatio, 0.4); });
test('delegation preparation is optional and adds to the adjusted numerator', () => {
  const raw = calculateDelegation({ codexOut: 10, byModel: { opus: 90 } });
  assert.equal(raw.delegRatioWithPrep, raw.delegRatio);
  const adjusted = calculateDelegation({ codexOut: 10, byModel: { opus: 90 }, specAuthoringOut: 20 });
  assert.equal(adjusted.delegRatio, 0.1);
  assert.equal(adjusted.delegRatioWithPrep, 0.3);
  assert.equal(adjusted.specAuthoringOut, 20);
});
test('spec-authoring tokens use Bash and PowerShell character share and tolerate zero chars', () => {
  assert.equal(estimateSpecAuthoringTokens({ blocks: { tools: { Bash: 80, PowerShell: 20 } }, profile: { totalChars: 200, byCategory: { 'spec-authoring': { chars: 50 } } } }), 25);
  assert.equal(estimateSpecAuthoringTokens({ blocks: { tools: { Bash: 100 } }, profile: { totalChars: 0, byCategory: { 'spec-authoring': { chars: 1 } } } }), 0);
});
test('deleg command source counts latest cumulative Codex usage per session', () => { const { home } = fixture(), dir = path.join(home, '.codex', 'sessions'), previous = process.env.CODEX_SESSIONS_DIRS; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'x.jsonl'), '{"total_token_usage":{"output_tokens":3}}\n{"total_token_usage":{"output_tokens":8}}'); process.env.CODEX_SESSIONS_DIRS = dir; try { assert.deepEqual(collectCodexOutput({ home }), { outputTokens: 8, sessions: 1 }); } finally { if (previous === undefined) delete process.env.CODEX_SESSIONS_DIRS; else process.env.CODEX_SESSIONS_DIRS = previous; } });
test('countPatchLines counts patch changes but not headers or non-apply_patch commands', () => {
  const patch = '*** Begin Patch\n--- old/file\n+++ new/file\n@@ -1 +1 @@\n-old\n+new\n+added\n*** End Patch';
  const text = [
    JSON.stringify({ type: 'response_item', payload: { name: 'apply_patch', arguments: patch } }),
    JSON.stringify({ type: 'response_item', payload: { name: 'shell_command', arguments: '-ignored\n+ignored' } }),
  ].join('\n');
  assert.deepEqual(countPatchLines(text), { added: 2, deleted: 1 });
});
test('calculateLinesDelegation uses authored lines and returns null for an empty denominator', () => {
  assert.equal(calculateLinesDelegation({ codexLines: 0, claudeLines: 0 }), null);
  assert.equal(calculateLinesDelegation({ codexLines: 15, claudeLines: 10 }), 0.6);
});
test('Claude authored lines count editing tools and inline programs without the hook threshold', () => {
  const { home, file } = fixture(), now = Date.now();
  const content = [
    { type: 'tool_use', name: 'Edit', input: { new_string: 'a\nb' } },
    { type: 'tool_use', name: 'Write', input: { content: 'c\nd\ne' } },
    { type: 'tool_use', name: 'MultiEdit', input: { edits: [{ new_string: 'f' }, { new_string: 'g\nh' }] } },
    { type: 'tool_use', name: 'Bash', input: { command: 'python - <<\'PY\'\ni = 1\nprint(i)\nPY' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'node tools/codex-do.mjs "node -e ignored"' } },
  ];
  fs.writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'assistant', message: { role: 'assistant', content } }));
  assert.equal(collectClaudeLines({ home, now }), 10);
  assert.equal(extractInlineProgram('node tools/codex-do.mjs "node -e ignored"'), null);
});
test('collectLandedLines sums numstat from two commits', { skip: process.env.PATH?.split(path.delimiter).every((dir) => !fs.existsSync(path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git'))) }, (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'landed-lines-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => import('node:child_process').then(({ execFileSync }) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' }));
  return git('init').then(() => git('config', 'user.email', 'test@example.com')).then(() => git('config', 'user.name', 'Test')).then(() => {
    fs.writeFileSync(path.join(repo, 'sample.txt'), 'one\ntwo\n'); return git('add', '.');
  }).then(() => git('commit', '-m', 'first')).then(() => {
    fs.writeFileSync(path.join(repo, 'sample.txt'), 'one changed\ntwo\nthree\n'); return git('add', '.');
  }).then(() => git('commit', '-m', 'second')).then(() => {
    assert.deepEqual(collectLandedLines({ repos: [repo], days: 7 }), { added: 4, deleted: 1, repos: 1 });
  });
});
