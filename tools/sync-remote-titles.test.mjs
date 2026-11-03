import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncRemoteTitles, untitledBridge } from './sync-remote-titles.mjs';

const now = Date.parse('2026-10-23T03:00:00Z');
const bridge = (id) => JSON.stringify({ type: 'bridge-session', sessionId: id, bridgeSessionId: `cse_${id}` }) + '\n';
const user = JSON.stringify({ type: 'user', message: { content: '下記を対応して。' } }) + '\n';
const reply = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });

function fixture(t, files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'title-sync-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  const project = path.join(base, 'projects', 'p');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org' } }));
  for (const [name, body, ageMin] of files) {
    const file = path.join(project, `${name}.jsonl`);
    fs.writeFileSync(file, body);
    const when = new Date(now - ageMin * 60_000);
    fs.utimesSync(file, when, when);
  }
  return { base, project };
}

test('untitledBridge picks only bridge transcripts without a title line', () => {
  assert.deepEqual(untitledBridge(bridge('a') + user), { sessionId: 'a', bridgeSessionId: 'cse_a' });
  assert.equal(untitledBridge(user), null);
  assert.equal(untitledBridge(bridge('a') + user + JSON.stringify({ type: 'ai-title', aiTitle: 'x' }) + '\n'), null);
  assert.equal(untitledBridge(bridge('a') + JSON.stringify({ type: 'custom-title', customTitle: 'x' }) + '\n'), null);
});

test('appends the server title, keeps mtime, skips live and non-bridge sessions', async (t) => {
  const { base, project } = fixture(t, [['idle', bridge('idle') + user, 30], ['live', bridge('live') + user, 2], ['plain', user, 30]]);
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return reply({ response_shape: { title: '2026年10月の重大脆弱性への対応' } }); };
  const before = fs.statSync(path.join(project, 'idle.jsonl')).mtimeMs;
  const result = await syncRemoteTitles({ base, now, fetchImpl });
  assert.equal(result.titled, 1);
  assert.deepEqual(calls, ['https://api.anthropic.com/v1/code/sessions/cse_idle']);
  const last = fs.readFileSync(path.join(project, 'idle.jsonl'), 'utf8').trim().split('\n').at(-1);
  assert.deepEqual(JSON.parse(last), { type: 'custom-title', customTitle: '2026年10月の重大脆弱性への対応', sessionId: 'idle' });
  assert.equal(fs.statSync(path.join(project, 'idle.jsonl')).mtimeMs, before);
  assert.equal(fs.readFileSync(path.join(project, 'live.jsonl'), 'utf8'), bridge('live') + user);
  assert.deepEqual(await syncRemoteTitles({ base, now: now + 60_000, fetchImpl }), { skipped: 'cooldown' });
  await syncRemoteTitles({ base, now: now + 20 * 60_000, fetchImpl });
  assert.equal(calls.filter((u) => u.endsWith('cse_idle')).length, 1);
  assert.equal(calls.filter((u) => u.endsWith('cse_live')).length, 1);
});

test('http failure and dry-run leave transcripts untouched', async (t) => {
  const { base, project } = fixture(t, [['a', bridge('a') + user, 30]]);
  assert.equal((await syncRemoteTitles({ base, now, fetchImpl: async () => reply({}, 500) })).failed, 1);
  const dry = await syncRemoteTitles({ base, now, dryRun: true, fetchImpl: async () => reply({ title: 'T' }) });
  assert.deepEqual(dry.sessions, [{ sessionId: 'a', title: 'T' }]);
  assert.equal(fs.readFileSync(path.join(project, 'a.jsonl'), 'utf8'), bridge('a') + user);
  const placeholder = await syncRemoteTitles({ base, now, dryRun: true, fetchImpl: async () => reply({ title: 'remote-control-mossy-island' }) });
  assert.deepEqual(placeholder.sessions, []);
});
