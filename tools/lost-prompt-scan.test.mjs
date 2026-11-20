import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { dispatch } from './hook-dispatch.mjs';
import { repositoryHooks } from './hook-dispatch-registry.mjs';
import { listItems } from './kim-inbox.mjs';
import { hookMain } from './lost-prompt-context.mjs';
import { findLostPrompts } from './lost-prompt-scan.mjs';
import { journalDir, journalPrompt } from './prompt-journal.mjs';
import { registerLostPromptScan } from './register-lost-prompt-scan-task.mjs';

const session = '2076fd36-ae6b-4462-ac35-e6cfc0365caf';
const repo = fileURLToPath(new URL('..', import.meta.url));
const at = new Date('2026-11-19T11:53:07Z');
const emptyManifest = { events: {} };

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-prompt-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, '.claude', 'projects', 'test-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  return { home, transcript: path.join(project, session + '.jsonl') };
}

test('journal precedes other hooks under load and redacts the payload', async t => {
  const { home } = fixture(t);
  const hook = { name: 'test-hook', critical: true, node: true };
  const file = path.join(journalDir(home), new Date().toISOString().slice(0, 10) + '.jsonl');
  const synthetic = 'fixture-value-for-test';
  await dispatch('UserPromptSubmit', JSON.stringify({ session_id: session, prompt: `日本語\nAPI_KEY="${synthetic}"` }), {
    home, overloaded: true, manifest: { events: { UserPromptSubmit: [hook] } },
    execute() {
      const row = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(row.session_id, session);
      assert.ok(row.prompt.includes('日本語') && row.prompt.includes('REDACTED'));
      assert.ok(!row.prompt.includes(synthetic));
      return { status: 0 };
    },
  });
  const before = performance.now();
  assert.ok(journalPrompt({ session_id: session, prompt: '短い返答' }, { home, now: at }));
  t.diagnostic(`journal append: ${(performance.now() - before).toFixed(2)} ms`);
  assert.ok(performance.now() - before < 50);
  assert.deepEqual(repositoryHooks(repo, home).SessionStart.some(group => group.hooks[0].command.includes('lost-prompt-context.mjs')), true);
});

test('scanner CLI delivers deduplicated info and matches each transcript occurrence once', async t => {
  const { home, transcript } = fixture(t);
  const prompt = '未達の返答です。'.repeat(15);
  const input = { session_id: session, prompt, transcript_path: transcript };
  const lostId = journalPrompt(input, { home, now: at });
  journalPrompt(input, { home, now: new Date(+at + 1000) });
  fs.writeFileSync(transcript, [
    { type: 'user', sessionId: session, timestamp: new Date(+at - 1), message: { content: prompt } },
    { type: 'queue-operation', operation: 'enqueue', content: prompt },
    { type: 'user', sessionId: session, isMeta: true, timestamp: new Date(+at + 1500), message: { content: prompt } },
    { type: 'user', sessionId: session, timestamp: new Date(+at + 2000), message: { content: [{ type: 'text', text: prompt }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const before = fs.readFileSync(transcript);
  const found = await findLostPrompts({ home, now: +at + 120_000 });
  assert.deepEqual(found.map(row => row.id), [lostId]);
  for (let i = 0; i < 2; i++) {
    assert.match(execFileSync(process.execPath, [path.join(repo, 'tools', 'lost-prompt-scan.mjs')], {
      env: { ...process.env, ORGIAST_HOME: home }, encoding: 'utf8',
    }), /1 unmatched/);
  }
  const [item, ...others] = listItems(home);
  assert.equal(others.length, 0);
  assert.equal(item.kind, 'info');
  assert.equal(item.sessionId, session);
  assert.equal(item.text.split('\n').at(-1), [...prompt].slice(0, 80).join(''));
  assert.deepEqual(fs.readFileSync(transcript), before);
});

test('session recovery repeats until an accepted Stop acknowledges the answer', async t => {
  const { home, transcript } = fixture(t);
  const id = journalPrompt({ session_id: session, prompt: 'これに回答して', transcript_path: transcript }, { home, now: at });
  const contextHook = { name: 'lost-prompt-context.mjs', critical: true, node: true };
  const manifest = { events: { SessionStart: [contextHook], UserPromptSubmit: [contextHook] } };
  const input = { session_id: session, transcript_path: transcript };
  const opts = {
    home, manifest, overloaded: true,
    async execute(_hook, raw) {
      let stdout = '';
      await hookMain(raw, { home, stdout: value => { stdout = value; } });
      return { status: 0, stdout };
    },
  };
  for (const event of ['SessionStart', 'UserPromptSubmit', 'UserPromptSubmit']) {
    const result = await dispatch(event, JSON.stringify(input), opts);
    assert.match(result.payload.hookSpecificOutput.additionalContext, /kim の未達の返答: これに回答して/);
  }
  await dispatch('Stop', JSON.stringify({ ...input, last_assistant_message: '別件の回答' }), { home, manifest: emptyManifest });
  assert.equal((await findLostPrompts({ home })).length, 1);
  await dispatch('Stop', JSON.stringify({ ...input, last_assistant_message: `回答です。\nprompt-journal-answered: ${id}` }), { home, manifest: emptyManifest });
  assert.deepEqual((await dispatch('UserPromptSubmit', JSON.stringify(input), opts)).payload, {});
});

test('intentionally blocked prompts do not enter recovery', async t => {
  const { home } = fixture(t);
  const hook = { name: 'gate', critical: true, node: true };
  const out = await dispatch('UserPromptSubmit', JSON.stringify({ session_id: session, prompt: 'blocked' }), {
    home, manifest: { events: { UserPromptSubmit: [hook] } },
    execute: () => ({ status: 2, stderr: 'blocked' }),
  });
  assert.equal(out.payload.decision, 'block');
  assert.deepEqual(await findLostPrompts({ home, graceMs: 0 }), []);
});

test('scheduler convergence entry targets an hourly local scan', () => {
  const plan = registerLostPromptScan({ dryRun: true });
  assert.equal(plan.interval, 'PT1H');
  assert.match(plan.arguments, /lost-prompt-scan\.mjs"\s*$/);
  const setup = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'setup-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.match(JSON.stringify(setup), /OrgiastLostPromptScan.*?register-lost-prompt-scan-task\.mjs/);
});
