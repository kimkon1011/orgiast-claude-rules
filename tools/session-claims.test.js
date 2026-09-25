import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./session-claims.mjs', import.meta.url));
const self = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const purpose = 'aujust 制作シート同期を修正する';
const unrelated = 'keyserve 暗号鍵ローテーション';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-claims-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  fs.mkdirSync(base);
  const env = { ...process.env, HOME: home, USERPROFILE: home, ORGIAST_HOME: home, CLAUDE_SESSION_ID: '' };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: home, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const ledger = () => JSON.parse(fs.readFileSync(path.join(base, 'session-claims.json'), 'utf8'));
  const transcript = (id, entries) => {
    const dir = path.join(base, 'projects', 'project', 'nested');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n{broken json\n');
    return file;
  };
  const candidates = text => {
    const file = path.join(home, 'candidates.txt'); fs.writeFileSync(file, text); return file;
  };
  return { home, base, env, run, ledger, transcript, candidates };
}
const declaration = (text = purpose, type = 'assistant') => ({ type, message: { content: `**[本セッションの目的]** ${text}` } });

test('claim upserts one session and list displays its purpose', t => {
  const f = fixture(t);
  assert.equal(f.run('--claim', '--self', self, '--purpose', unrelated).stdout, '');
  f.run('--claim', '--self', self, '--purpose', purpose);
  assert.match(f.run('--list').stdout, /11111111.*aujust/);
  const claims = JSON.parse(f.run('--list', '--json').stdout);
  assert.equal(claims.length, 1); assert.equal(claims[0].purpose, purpose);
  assert.equal(claims[0].sessionId, self); assert.ok(claims[0].tokens.includes('制作'));
});

test('release stays released after sync even with an active transcript', t => {
  const f = fixture(t); f.transcript(self, [declaration()]);
  f.run('--sync');
  assert.equal(f.run('--release', '--self', self).stdout, '');
  assert.equal(f.run('--list').stdout, '');
  assert.equal(f.ledger().claims[0].releasedReason, 'closed');
  f.run('--claim', '--self', self, '--purpose', unrelated);
  assert.match(f.run('--list').stdout, /keyserve/);
});

test('transcript older than eight hours is stale, even with a fresh purpose gate', t => {
  const f = fixture(t); const file = f.transcript(other, [declaration()]);
  const old = new Date(Date.now() - 9 * 3600000); fs.utimesSync(file, old, old);
  fs.mkdirSync(path.join(f.base, 'session-purpose'));
  fs.writeFileSync(path.join(f.base, 'session-purpose', 'stripped-id.json'), JSON.stringify({ sessionId: other, purpose: `**[本セッションの目的]** ${purpose}` }));
  assert.equal(f.run('--sync').stdout, ''); assert.equal(f.run('--list').stdout, '');
  const c = f.ledger().claims[0];
  assert.equal(c.releasedReason, 'stale'); assert.equal(c.lastActivity, old.toISOString());
});

test('release followed by an older-timestamp claim survives newer backing files', t => {
  const f = fixture(t);
  f.transcript(self, [declaration()]);
  fs.mkdirSync(path.join(f.base, 'session-purpose'));
  fs.writeFileSync(path.join(f.base, 'session-purpose', `${self}.json`), JSON.stringify({ sessionId: self, purpose }));
  f.run('--release', '--self', self);
  fs.appendFileSync(path.join(f.base, 'session-claims.jsonl'), JSON.stringify({
    ts: new Date(Date.now() - 60000).toISOString(), op: 'claim', sessionId: self, purpose: unrelated,
  }) + '\n');
  f.run('--sync');
  const claims = JSON.parse(f.run('--list', '--json').stdout);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].purpose, unrelated);
  assert.equal(claims[0].released, false);
});

for (const reason of ['closed', 'stale']) {
  test(`explicit release (${reason}) keeps an active transcript purpose available to filter`, t => {
    const f = fixture(t);
    const file = f.transcript(other, [declaration()]);
    f.run('--sync');
    f.run('--release', '--self', other, '--reason', reason);
    const fresh = new Date(Date.now() + 1000);
    fs.utimesSync(file, fresh, fresh);
    f.run('--sync');
    assert.deepEqual(JSON.parse(f.run('--list', '--json').stdout), []);
    const result = f.run('--filter', '--self', self, '--candidates', f.candidates(purpose));
    assert.equal(result.stdout, `${purpose}\n`);
    assert.equal(result.stderr, '');
    assert.equal(f.ledger().claims[0].released, true);
    assert.equal(f.ledger().claims[0].releasedReason, reason);
  });
}

test('a later release wins even when its timestamp precedes the claim', t => {
  const f = fixture(t);
  f.transcript(self, [declaration()]);
  f.run('--claim', '--self', self, '--purpose', purpose);
  fs.appendFileSync(path.join(f.base, 'session-claims.jsonl'), JSON.stringify({
    ts: new Date(Date.now() - 60000).toISOString(), op: 'release', sessionId: self,
  }) + '\n');
  f.run('--sync');
  assert.deepEqual(JSON.parse(f.run('--list', '--json').stdout), []);
});

test('user and injected templates never produce a transcript claim', t => {
  const f = fixture(t);
  const text = `**[本セッションの目的]** ${purpose}`;
  f.transcript(other, [declaration(purpose, 'user'),
    { type: 'user', message: { content: [{ type: 'text', text }] } },
    { type: 'system', content: text, additionalContext: text },
    { type: 'assistant', additionalContext: text, message: { content: [
      { type: 'thinking', thinking: text }, { type: 'tool_use', input: { text } },
    ] } }]);
  f.run('--sync'); assert.deepEqual(f.ledger().claims, []);
});

test('filter drops claimed candidates and preserves unrelated lines exactly', t => {
  const f = fixture(t); f.run('--claim', '--self', other, '--purpose', purpose);
  const file = f.candidates(`# comment\n\n${purpose}\n  ${unrelated}  \n`);
  const r = f.run('--filter', '--self', self, '--candidates', file);
  assert.equal(r.stdout, `  ${unrelated}  \n`);
  assert.equal(r.stderr, `dropped: ${purpose} <- claimed by 22222222 (1.00)\n`);
  const all = f.run('--filter', '--self', self, '--candidates', f.candidates(purpose));
  assert.equal(all.stdout, '');
});

test('filter never excludes its own claim, including environment self ID', t => {
  const f = fixture(t); f.transcript(self, [declaration()]);
  f.env.CLAUDE_SESSION_ID = self;
  const r = f.run('--filter', '--candidates', f.candidates(purpose));
  assert.equal(r.stdout, `${purpose}\n`); assert.equal(r.stderr, '');
  assert.equal(f.ledger().claims[0].sessionId, self);
});

test('corrupt ledger recovers silently from transcripts', t => {
  const f = fixture(t); f.transcript(other, [declaration()]);
  for (const raw of ['{broken', '{"version":1,"claims":[null,{}]}']) {
    fs.writeFileSync(path.join(f.base, 'session-claims.json'), raw);
    const r = f.run('--sync'); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
    assert.equal(f.ledger().claims[0].purpose, purpose);
  }
});

test('transcript last assistant declaration takes priority over even a declared gate', t => {
  const f = fixture(t);
  f.transcript(other, [declaration(unrelated), { type: 'assistant', message: { content: [
    { type: 'text', text: `**[本セッションの目的]** discarded **[本セッションの目的]** ${purpose}` },
  ] } }, declaration(unrelated, 'user')]);
  f.run('--sync'); assert.equal(f.ledger().claims[0].purpose, purpose);
  fs.mkdirSync(path.join(f.base, 'session-purpose'));
  const file = path.join(f.base, 'session-purpose', 'sanitized.json');
  fs.writeFileSync(file, JSON.stringify({ sessionId: other, purpose: `**[本セッションの目的]** ${unrelated}` }));
  f.run('--sync'); const c = f.ledger().claims[0];
  assert.equal(c.purpose, purpose); assert.equal(c.source, 'transcript');
  fs.writeFileSync(file, JSON.stringify({ sessionId: other, purpose: '' }));
  f.run('--sync'); assert.equal(f.ledger().claims[0].purpose, purpose);
});

test('concurrent claims retain all updates and leave valid JSON', async t => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--claim', '--self', `session-${i}`, '--purpose', purpose],
      { cwd: f.home, env: f.env, stdio: 'pipe' });
    let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    child.on('error', reject); child.on('close', code => {
      try { assert.equal(code, 0); assert.equal(output, ''); resolve(); } catch (e) { reject(e); }
    });
  })));
  assert.equal(f.ledger().claims.length, 12);
  assert.equal(fs.existsSync(path.join(f.base, 'session-claims.json.tmp')), false);
});

test('24 concurrent claims retain all updates and leave valid JSON', async t => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 24 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--claim', '--self', `session-${i}`, '--purpose', purpose],
      { cwd: f.home, env: f.env, stdio: 'pipe' });
    let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    child.on('error', reject); child.on('close', code => {
      try { assert.equal(code, 0); assert.equal(output, ''); resolve(); } catch (e) { reject(e); }
    });
  })));
  assert.equal(f.ledger().claims.length, 24);
  assert.equal(fs.existsSync(path.join(f.base, 'session-claims.json.tmp')), false);
});

test('unexpected missing candidate file exits zero silently', t => {
  const f = fixture(t);
  const r = f.run('--filter', '--self', self, '--candidates', path.join(f.home, 'missing'));
  assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
});

test('claim recovers a lock directory older than thirty seconds', t => {
  const f = fixture(t);
  f.run('--claim', '--self', self, '--purpose', purpose);
  const lock = path.join(f.base, 'session-claims.lock');
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 31000);
  fs.utimesSync(lock, old, old);
  const result = f.run('--claim', '--self', other, '--purpose', unrelated);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.deepEqual(new Set(f.ledger().claims.map(c => c.sessionId)), new Set([self, other]));
  assert.equal(fs.existsSync(lock), false);
});

for (const command of ['--claim', '--release', '--sync']) {
  test(`${command} waits for the holder and rereads its committed claim`, async t => {
    const f = fixture(t);
    f.run('--claim', '--self', self, '--purpose', purpose);
    const committed = f.ledger();
    committed.claims.push({ ...committed.claims[0], sessionId: other, short: other.slice(0, 8), purpose: unrelated });
    const lock = path.join(f.base, 'session-claims.lock');
    fs.mkdirSync(lock);
    // Signal actual contention, rather than assuming a child has started after
    // an arbitrary sleep. The parent acts as the first transaction's holder.
    const preload = `
      import fs from 'node:fs';
      const mkdir = fs.mkdirSync;
      let reported = false;
      fs.mkdirSync = function (...args) {
        try { return mkdir.apply(this, args); } catch (error) {
          if (error.code === 'EEXIST' && String(args[0]).endsWith('session-claims.lock') && !reported) {
            reported = true;
            process.send('waiting');
          }
          throw error;
        }
      };
    `;
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      script, command, '--self', self, '--purpose', purpose],
    { cwd: f.home, env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '', contended = false;
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('child did not finish')); }, 10000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('message', message => {
        try {
          assert.equal(message, 'waiting');
          contended = true;
          fs.writeFileSync(path.join(f.base, 'session-claims.json'), JSON.stringify(committed));
          fs.appendFileSync(path.join(f.base, 'session-claims.jsonl'), JSON.stringify({
            ts: new Date().toISOString(), op: 'claim', sessionId: other, purpose: unrelated, source: 'purpose-gate',
          }) + '\n');
          fs.rmdirSync(lock);
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      child.on('close', code => {
        clearTimeout(timer);
        try { assert.equal(code, 0); assert.equal(output, ''); resolve(); } catch (error) { reject(error); }
      });
    });
    assert.equal(contended, true);
    const claims = f.ledger().claims;
    assert.deepEqual(new Set(claims.map(c => c.sessionId)), new Set([self, other]));
    assert.equal(claims.find(c => c.sessionId === self).released, command === '--release');
    assert.equal(claims.find(c => c.sessionId === other).purpose, unrelated);
    assert.equal(fs.existsSync(lock), false);
  });
}

test('a fresh held cache lock cannot discard an appended claim', t => {
  const f = fixture(t);
  f.run('--claim', '--self', self, '--purpose', purpose);
  const before = f.ledger();
  const lock = path.join(f.base, 'session-claims.lock');
  fs.mkdirSync(lock);
  const started = performance.now();
  const result = f.run('--claim', '--self', other, '--purpose', unrelated);
  const elapsed = performance.now() - started;
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.ok(elapsed >= 1900, `gave up early: ${elapsed}ms`);
  assert.ok(elapsed < 4000, `exceeded retry budget including process startup: ${elapsed}ms`);
  assert.deepEqual(f.ledger(), before);
  assert.equal(fs.existsSync(lock), true);
  const rows = fs.readFileSync(path.join(f.base, 'session-claims.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.sessionId), [self, other]);
  assert.deepEqual(new Set(JSON.parse(f.run('--list', '--json').stdout).map(c => c.sessionId)), new Set([self, other]));
});

test('log order wins over timestamps and a later claim revives a released session', t => {
  const f = fixture(t);
  const ts = new Date().toISOString();
  const rows = [
    { ts, op: 'claim', sessionId: self, purpose },
    { ts, op: 'release', sessionId: self, reason: 'closed' },
    { ts: new Date(Date.parse(ts) - 1000).toISOString(), op: 'claim', sessionId: self, purpose: unrelated },
  ];
  fs.writeFileSync(path.join(f.base, 'session-claims.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const claims = JSON.parse(f.run('--list', '--json').stdout);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].purpose, unrelated);
  assert.equal(claims[0].released, false);
});

test('malformed log lines are ignored without losing surrounding records', t => {
  const f = fixture(t);
  f.run('--claim', '--self', self, '--purpose', purpose);
  fs.appendFileSync(path.join(f.base, 'session-claims.jsonl'), '{broken json\nnull\n{}\n');
  f.run('--claim', '--self', other, '--purpose', unrelated);
  assert.deepEqual(new Set(JSON.parse(f.run('--list', '--json').stdout).map(c => c.sessionId)), new Set([self, other]));
});

test('unwritable cache cannot prevent claim, release, list or filter', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.base, 'session-claims.json'));
  f.run('--claim', '--self', other, '--purpose', purpose);
  assert.equal(JSON.parse(f.run('--list', '--json').stdout)[0].sessionId, other);
  const blocked = f.run('--filter', '--self', self, '--candidates', f.candidates(purpose));
  assert.equal(blocked.stdout, '');
  assert.match(blocked.stderr, /dropped:/);
  f.run('--release', '--self', other);
  assert.deepEqual(JSON.parse(f.run('--list', '--json').stdout), []);
  const free = f.run('--filter', '--self', self, '--candidates', f.candidates(purpose));
  assert.equal(free.stdout, purpose + '\n');
  assert.equal(free.stderr, '');
});

test('cache contents never override the authoritative log', t => {
  const f = fixture(t);
  f.run('--claim', '--self', self, '--purpose', purpose);
  const cached = f.ledger();
  cached.claims[0].purpose = unrelated;
  cached.claims[0].released = true;
  fs.writeFileSync(path.join(f.base, 'session-claims.json'), JSON.stringify(cached));
  assert.equal(JSON.parse(f.run('--list', '--json').stdout)[0].purpose, purpose);
});

test('real Windows record shapes work with HOME/USERPROFILE and debug stays on stderr', t => {
  const f = fixture(t);
  delete f.env.ORGIAST_HOME;
  const read = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/session-claims/${name}.json`, import.meta.url), 'utf8'));
  const record = read('assistant'), gate = read('purpose-gate');
  f.transcript(record.sessionId, [record]);
  const dir = path.join(f.base, 'session-purpose');
  fs.mkdirSync(dir);
  const gateFile = path.join(dir, 'sanitized-filename.json');
  fs.writeFileSync(gateFile, JSON.stringify(gate));
  const result = f.run('--sync', '--debug');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session-purpose 走査 = 1 \/ purpose 取得 = 1/);
  assert.match(result.stderr, /transcript 8時間以内 = 1 \/ assistant 宣言取得 = 1; 宣言を持つセッション数 = 1 \/ 宣言が無くスキップした数 = 0; 生存 claim = 1/);
  assert.match(result.stderr, /SyntaxError/); // malformed transcript tail, as in other fixtures
  assert.equal(f.ledger().claims[0].sessionId, record.sessionId);
  assert.equal(f.ledger().claims[0].purpose, purpose);
  fs.unlinkSync(gateFile);
  const listed = f.run('--list');
  assert.equal(listed.stderr, '');
  assert.match(listed.stdout, /^22222222  \S+  aujust 制作シート同期を修正する\n$/);
});

test('debug exposes cache and top-level errors while remaining fail-open', t => {
  const f = fixture(t);
  f.transcript(other, [declaration()]);
  fs.mkdirSync(path.join(f.base, 'session-claims.json'));
  const listed = f.run('--list', '--debug');
  assert.match(listed.stdout, /22222222/);
  assert.match(listed.stderr, /updateCache: /);
  const missing = f.run('--filter', '--debug', '--self', self, '--candidates', path.join(f.home, 'missing'));
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /main: ENOENT/);
  const preload = `import fs from 'node:fs';
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = function (dir, ...args) {
      if (String(dir) === process.env.TEST_CLAIMS_BASE) {
        throw Object.assign(new Error('read-only directory'), { code: 'EROFS' });
      }
      return mkdir.call(this, dir, ...args);
    };`;
  const denied = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    script, '--list', '--debug'], {
    cwd: f.home, env: { ...f.env, TEST_CLAIMS_BASE: f.base }, encoding: 'utf8',
  });
  assert.equal(denied.status, 0);
  assert.match(denied.stdout, /22222222/);
  assert.match(denied.stderr, /EROFS/);
});

for (const noise of ['<agent-message from="agent"> hand-back', '<ide_opened_file>opened file',
  'https://docs.google.com/document/d/example', 'あなたは代表 kim の秘書。3 フェーズを実行してください。']) {
  test(`undeclared gate prompt never creates a claim: ${noise}`, t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.base, 'session-purpose'));
    fs.writeFileSync(path.join(f.base, 'session-purpose', `${other}.json`), JSON.stringify({ purpose: noise }));
    f.transcript(other, [declaration(purpose, 'user')]);
    fs.writeFileSync(path.join(f.base, 'session-claims.json'), JSON.stringify({ claims: [
      { sessionId: other, purpose: noise, source: 'purpose-gate', released: false },
    ] }));
    const result = f.run('--sync', '--debug');
    assert.deepEqual(f.ledger().claims, []);
    assert.equal(f.run('--list').stdout, '');
    assert.match(result.stderr, /宣言を持つセッション数 = 0 \/ 宣言が無くスキップした数 = 1/);
  });
}

test('a standalone gate declaration is allowed only as fallback and extracts one purpose line', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.base, 'session-purpose'));
  const file = path.join(f.base, 'session-purpose', `${other}.json`);
  fs.writeFileSync(file, JSON.stringify({ purpose: '**[本セッションの目的]** 〇〇' }));
  f.run('--sync');
  assert.equal(f.ledger().claims[0].purpose, '〇〇');
  assert.equal(f.ledger().claims[0].source, 'purpose-gate');
  fs.writeFileSync(file, JSON.stringify({ purpose: `injected example\n**[本セッションの目的]** ${purpose}` }));
  f.run('--sync');
  assert.deepEqual(f.ledger().claims, []);
});

test('sync discards prior inferred noise even when there are no backing files', async t => {
  const { syncClaims } = await import('./session-claims.mjs');
  const f = fixture(t);
  assert.deepEqual(syncClaims(f.base, [{ sessionId: other, purpose: '<agent-message>noise',
    source: 'purpose-gate', lastActivity: new Date().toISOString() }]), []);
});

test('last assistant declaration wins across records and text blocks, including a short purpose', t => {
  const f = fixture(t);
  f.transcript(other, [declaration(), { type: 'assistant', message: { content: [
    { type: 'text', text: `**[本セッションの目的]** ${unrelated}` },
    { type: 'text', text: '**[本セッションの目的]** 〇〇\n次の説明行' },
  ] } }, declaration(purpose, 'user')]);
  f.run('--sync');
  assert.equal(f.ledger().claims[0].purpose, '〇〇');
});
