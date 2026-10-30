import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  filterWindowsForCurrentAuth,
  tickPrompt, contractPrompt,
  commandRunner, interactiveClaude,
} from '../../tools/quota-sweep.mjs';

const now = Date.UTC(2026, 9, 21);
const minute = 60_000;

const temp = t => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-sweep-runtime-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
};

// ── filterWindowsForCurrentAuth ───────────────────────────────────────

test('filterWindowsForCurrentAuth keeps all windows when no auth change', () => {
  const windows = Object.assign(
    [{ provider: 'claude', window: '5h' }, { provider: 'codex', observedAt: 100, window: 'primary' }],
    { reasons: { claude: null, codex: null } }
  );
  const filtered = filterWindowsForCurrentAuth(windows, {});
  assert.equal(filtered.length, 2);
  assert.ok(filtered.reasons);
});

test('filterWindowsForCurrentAuth filters codex windows before auth change', () => {
  const windows = Object.assign(
    [{ provider: 'claude', window: '5h' }, { provider: 'codex', observedAt: 50, window: 'primary' }],
    { reasons: { claude: null, codex: 'HTTP 401' } }
  );
  const filtered = filterWindowsForCurrentAuth(windows, { codexAuthChangedAt: 100 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].provider, 'claude');
  assert.ok(filtered.reasons);
});

test('filterWindowsForCurrentAuth keeps reasons property', () => {
  const all = Object.assign([], { reasons: { claude: 'HTTP 429', codex: null } });
  const filtered = filterWindowsForCurrentAuth(all, {});
  assert.deepEqual(filtered.reasons, { claude: 'HTTP 429', codex: null });
});

// ── tickPrompt and contractPrompt ─────────────────────────────────────

test('tickPrompt formats correctly for claude slug', () => {
  const prompt = tickPrompt('quota-sweep-claude');
  assert.ok(prompt.startsWith('[headless:quota-sweep]'));
  assert.ok(prompt.includes('.loop/quota-sweep-claude.md'));
  assert.ok(prompt.includes('FINAL'));
  assert.ok(prompt.includes('ITERATING'));
  assert.ok(prompt.includes('.loop/quota-sweep-claude-state.md'));
});

test('tickPrompt forbids push/PR/merge', () => {
  const prompt = tickPrompt('quota-sweep-codex');
  assert.ok(prompt.includes('push/PR/merge は行わない'));
});

test('contractPrompt includes makeloop command', () => {
  const prompt = contractPrompt('claude', 'quota-sweep-claude', 'fix tests');
  assert.ok(prompt.includes('/makeloop'));
  assert.ok(prompt.includes('fix tests'));
  assert.ok(prompt.includes('closed'));
  assert.ok(prompt.includes('日本語'));
});

test('contractPrompt uses $makeloop for codex', () => {
  const prompt = contractPrompt('codex', 'quota-sweep-codex', 'goal');
  assert.ok(prompt.includes('$makeloop:makeloop'));
});

test('contractPrompt template includes all mandatory fields', () => {
  const prompt = contractPrompt('claude', 'quota-sweep-claude', 'test-goal');
  assert.ok(prompt.includes('検証ゲート'));
  assert.ok(prompt.includes('累積上限'));
  assert.ok(prompt.includes('日本語'));
  assert.ok(prompt.includes('kind=closed'));
  assert.ok(prompt.includes('/makeloop'));
  assert.ok(prompt.includes('test-goal'));
});

// ── commandRunner — network retry ─────────────────────────────────────

test('commandRunner retries network commands once', () => {
  let calls = 0;
  const run = commandRunner(() => {
    calls++;
    return { error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stderr: '' };
  });
  assert.throws(() => run('git', ['fetch'], '/tmp'));
  assert.equal(calls, 2);
});

test('commandRunner succeeds on retry', () => {
  let calls = 0;
  const run = commandRunner(() => ++calls === 1
    ? { status: 128, stderr: "fatal: Unable to create 'C:/repo/.git/worktrees/sweep/index.lock': File exists.\nAnother git process seems to be running" }
    : { status: 0, stdout: 'ok\n' });
  assert.equal(run('git', ['checkout', 'main'], '/tmp'), 'ok');
  assert.equal(calls, 2);
});

test('commandRunner does not retry non-network commands on first failure', () => {
  let calls = 0;
  const run = commandRunner(() => {
    calls++;
    return { error: new Error('command not found'), status: null };
  });
  assert.throws(() => run('node', ['--version'], '/tmp'));
  assert.equal(calls, 1);
});

test('commandRunner retries lock contention exactly once', () => {
  let calls = 0;
  const run = commandRunner(() => {
    calls++;
    return { status: 128, stderr: "fatal: Unable to create 'index.lock': File exists.\nAnother git process seems to be running" };
  });
  assert.throws(() => run('git', ['checkout', '--detach', 'origin/main'], '/tmp'));
  assert.equal(calls, 2);
});

// ── interactiveClaude — transcript detection ─────────────────────────

test('interactiveClaude returns false for headless transcripts', t => {
  const home = temp(t);
  const dir = path.join(home, '.claude/projects/repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const row = { type: 'user', message: { content: [{ type: 'text', text: '[headless:quota-sweep]\ngoal' }] } };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  fs.utimesSync(file, now / 1000, now / 1000);
  assert.equal(interactiveClaude({ home, now }), false);
});

test('interactiveClaude returns false for sdk-cli entries', t => {
  const home = temp(t);
  const dir = path.join(home, '.claude/projects/repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'probe.jsonl');
  const rows = [
    { type: 'attachment', entrypoint: 'sdk-cli' },
    { type: 'user', message: { content: [{ type: 'text', text: 'OK とだけ返してください' }] } },
  ];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, now / 1000, now / 1000);
  assert.equal(interactiveClaude({ home, now }), false);
});

test('interactiveClaude returns true for interactive entries', t => {
  const home = temp(t);
  const dir = path.join(home, '.claude/projects/repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const row = { type: 'user', message: { content: [{ type: 'text', text: 'help with this code' }] } };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  fs.utimesSync(file, now / 1000, now / 1000);
  assert.equal(interactiveClaude({ home, now }), true);
});

test('interactiveClaude ignores transcripts older than 10 minutes', t => {
  const home = temp(t);
  const dir = path.join(home, '.claude/projects/repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'old.jsonl');
  const row = { type: 'user', message: { content: [{ type: 'text', text: 'help' }] } };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  const old = (now - 20 * minute) / 1000;
  fs.utimesSync(file, old, old);
  assert.equal(interactiveClaude({ home, now }), false);
});