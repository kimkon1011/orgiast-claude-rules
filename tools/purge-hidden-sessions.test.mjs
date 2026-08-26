import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolvePython } from './session-list-tidy.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const purgeScript = path.join(toolsDir, 'purge-hidden-sessions.py');
const EMPTY_JSONL = [
  JSON.stringify({ type: 'mode', mode: 'default' }),
  JSON.stringify({ type: 'atis-latch', value: true }),
].join('\n') + '\n';
const NONEMPTY_JSONL = [
  JSON.stringify({ type: 'user', message: { content: '実ユーザー発言' } }),
  JSON.stringify({ type: 'assistant', message: { content: 'assistant 応答' } }),
].join('\n') + '\n';

test('closed/hidden セッションを削除せず安全な退避先へ move する', (t) => {
  const python = resolvePython();
  if (!python) return t.skip('Python interpreter is not available');

  const fakehome = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-hidden-sessions-'));
  t.after(() => fs.rmSync(fakehome, { recursive: true, force: true }));
  const claude = path.join(fakehome, '.claude');
  const project = path.join(claude, 'projects', 'testproj');
  fs.mkdirSync(project, { recursive: true });

  const ids = {
    closed: '11111111-1111-4111-8111-111111111111',
    hiddenEmpty: '22222222-2222-4222-8222-222222222222',
    hiddenNonempty: '33333333-3333-4333-8333-333333333333',
    live: '44444444-4444-4444-8444-444444444444',
  };
  for (const [kind, id] of Object.entries(ids)) {
    fs.writeFileSync(path.join(project, `${id}.jsonl`), kind === 'hiddenNonempty' ? NONEMPTY_JSONL : EMPTY_JSONL);
  }
  const old = new Date(Date.now() - 120_000);
  for (const id of Object.values(ids)) fs.utimesSync(path.join(project, `${id}.jsonl`), old, old);

  fs.writeFileSync(path.join(claude, 'closed-sessions.json'), JSON.stringify({ ids: [ids.closed] }));
  fs.writeFileSync(path.join(claude, 'hidden-sessions-ledger.json'), JSON.stringify({ ids: [ids.hiddenEmpty, ids.hiddenNonempty, ids.live] }));
  fs.writeFileSync(path.join(claude, 'current-session.json'), JSON.stringify({
    sessionId: ids.live,
    at: new Date().toISOString(),
  }));

  const result = spawnSync(python, [purgeScript], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fakehome, USERPROFILE: fakehome },
  });
  assert.equal(result.status, 0, result.stderr);

  const closedDest = path.join(claude, 'projects', '_deleted-backup', '_closed', 'testproj', `${ids.closed}.jsonl`);
  const hiddenDest = path.join(claude, 'projects', '_deleted-backup', 'testproj', `${ids.hiddenEmpty}.jsonl`);
  assert.ok(fs.existsSync(closedDest), 'closed セッションが _closed に退避される');
  assert.ok(fs.existsSync(hiddenDest), 'hidden の空セッションが通常の backup に退避される');
  assert.ok(fs.existsSync(path.join(project, `${ids.hiddenNonempty}.jsonl`)), '中身あり・120秒前の hidden は残る');
  assert.ok(fs.existsSync(path.join(project, `${ids.live}.jsonl`)), '稼働中セッションは残る');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claude, 'closed-sessions.json'), 'utf8')).ids, []);

  assert.ok(!fs.existsSync(path.join(project, `${ids.closed}.jsonl`)) && fs.existsSync(closedDest));
  assert.ok(!fs.existsSync(path.join(project, `${ids.hiddenEmpty}.jsonl`)) && fs.existsSync(hiddenDest));
});

test('並行する稼働中セッションを両方保護し、明示的に closed のものだけ move する', (t) => {
  const python = resolvePython();
  if (!python) return t.skip('Python interpreter is not available');

  const fakehome = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-hidden-sessions-parallel-'));
  t.after(() => fs.rmSync(fakehome, { recursive: true, force: true }));
  const claude = path.join(fakehome, '.claude');
  const project = path.join(claude, 'projects', 'testproj');
  const currentSessions = path.join(claude, 'current-sessions');
  fs.mkdirSync(currentSessions, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const first = '55555555-5555-4555-8555-555555555555';
  const second = '66666666-6666-4666-8666-666666666666';
  const old = new Date(Date.now() - 300_000);
  const now = new Date().toISOString();
  for (const id of [first, second]) {
    const jsonl = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(jsonl, EMPTY_JSONL);
    fs.utimesSync(jsonl, old, old);
    fs.writeFileSync(path.join(currentSessions, `${id}.json`), JSON.stringify({ sessionId: id, at: now }));
  }
  fs.writeFileSync(path.join(claude, 'hidden-sessions-ledger.json'), JSON.stringify({ ids: [first, second] }));

  const env = { ...process.env, HOME: fakehome, USERPROFILE: fakehome };
  let result = spawnSync(python, [purgeScript], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(project, `${first}.jsonl`)), '1件目の稼働中セッションは残る');
  assert.ok(fs.existsSync(path.join(project, `${second}.jsonl`)), '2件目の稼働中セッションも残る');

  fs.writeFileSync(path.join(claude, 'closed-sessions.json'), JSON.stringify({ ids: [first] }));
  result = spawnSync(python, [purgeScript], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const closedDest = path.join(claude, 'projects', '_deleted-backup', '_closed', 'testproj', `${first}.jsonl`);
  assert.ok(fs.existsSync(closedDest), '明示的に closed の稼働中セッションは退避される');
  assert.ok(!fs.existsSync(path.join(project, `${first}.jsonl`)), 'closed 側は元の場所から move される');
  assert.ok(fs.existsSync(path.join(project, `${second}.jsonl`)), 'closed でない稼働中セッションは残る');
});
