import assert from 'node:assert/strict';
import test from 'node:test';
import { geminiApiInvocation, isSafeInvocation, judge } from './gemini-api-budget-gate.mjs';

const event = command => ({ tool_name: 'Bash', tool_input: { command } });
const stop = () => ({ level: 'stop', pct: 471.2 });

test('stop denies a billable generate call', () => {
  const result = judge(event('gemini-api generate "hello"'), { statusProvider: stop });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /今月 471\.2%/);
  assert.match(result.reason, /--provider openrouter/);
});

for (const command of ['gemini-api generate ping --dry-run', 'gemini-api whoami -o json', 'gemini-api --help', 'gemini-api models', 'gemini-api explore topic']) {
  test(`stop allows safe invocation: ${command}`, () => assert.equal(judge(event(command), { statusProvider: stop }).decision, 'allow'));
}

test('ok allows a billable call', () => assert.equal(judge(event('gemini-api image cat'), { statusProvider: () => ({ level: 'ok', pct: 10 }) }).decision, 'allow'));

for (const command of ['grep gemini-api file', 'cat skills/gemini-api-cli/SKILL.md', 'git commit -m "gemini-api update"', 'echo "gemini-api generate cat"']) {
  test(`text occurrence is not treated as execution: ${command}`, () => assert.equal(geminiApiInvocation(command), null));
}

test('detects full path exe after a shell operator', () => {
  const found = geminiApiInvocation('echo ready && & "C:\\Tools\\gemini-api.exe" generate cat');
  assert.equal(found.args, 'generate cat');
  assert.equal(isSafeInvocation(found.args), false);
});

test('guard failure fails open with one warning', () => {
  const warnings = [];
  const result = judge(event('gemini-api generate hello'), { statusProvider: () => { throw new Error('timeout'); }, warn: value => warnings.push(value) });
  assert.equal(result.decision, 'allow');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /許可します/);
});
