import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Do NOT set ORGIAST_AUTO_RESUME – we rely on config state.

const roots = [];
const projectConfig = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'auto-resume.json'
);

test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(home) {
  fs.mkdirSync(path.join(home, '.claude', 'external-monitor-events'), { recursive: true });
  const event = {
    key: '0000000000000000000000000000000000000000000000000000000000000001',
    channel: 'line',
    threadId: 'group1',
    message: { id: 'msg1', at: '2026-11-12T05:00:00Z', sender: '担当者', text: 'test' },
    row: { sessionId: 'session-1', cwd: home, transcriptPath: '', owner: '', label: '' },
    queuedAt: '2026-11-12T06:00:00.000Z',
    state: 'pending',
    inboxId: 'inbox-1',
  };
  const file = path.join(home, '.claude', 'external-monitor-events', `${event.key}.json`);
  fs.writeFileSync(file, JSON.stringify(event));
}

test('config enabled:false では addKimInboxItem が呼ばれない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-integration-'));
  roots.push(home);
  setup(home);

  let addKimInboxItemCalled = false;
  const result = await (await import('../auto-progress-external-monitor.mjs')).drainExternalQueue({
    home,
    now: Date.parse('2026-11-12T06:30:00Z'),
    resume: async () => ({ state: 'needs_user' }),
    io: {
      addKimInboxItem: async () => { addKimInboxItemCalled = true; return { id: 'mock' }; },
    },
  });

  assert.equal(addKimInboxItemCalled, false, 'addKimInboxItem should NOT be called when config explicitly disables auto-resume');
  assert.equal(result.resumed, 0);
  const events = (await import('../lib/external-monitor-state.mjs')).readEvents(home);
  assert.equal(events.length, 1);
  assert.equal(events[0].state, 'disabled');
});

test('config 恒久無効ではないとき addKimInboxItem が呼ばれる', async t => {
  // Temporarily write a config with enabled omitted (just {}), so:
  // - autoResumeAllowed() returns false (enabled not true, no allowSources)
  // - autoResumeDisabledByConfig() returns false (enabled not false)
  // This makes drainExternalQueue enter the else-branch → addKimInboxItem IS called.
  const backup = fs.readFileSync(projectConfig, 'utf8');
  const restore = () => fs.writeFileSync(projectConfig, backup, 'utf8');
  t.after(restore);
  fs.writeFileSync(projectConfig, '{}', 'utf8');
  // ESM cache is not an issue – autoResumeAllowed/autoResumeDisabledByConfig
  // call fs.readFileSync on every invocation (lazy, no in-memory cache).

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-integration-'));
  roots.push(home);
  setup(home);

  let addKimInboxItemCalled = false;
  const result = await (await import('../auto-progress-external-monitor.mjs')).drainExternalQueue({
    home,
    now: Date.parse('2026-11-12T06:30:00Z'),
    resume: async () => ({ state: 'needs_user' }),
    io: {
      addKimInboxItem: async () => { addKimInboxItemCalled = true; return { id: 'mock' }; },
    },
  });

  assert.equal(addKimInboxItemCalled, true, 'addKimInboxItem SHOULD be called when config is not permanently disabled');
  assert.equal(result.resumed, 0);
});
