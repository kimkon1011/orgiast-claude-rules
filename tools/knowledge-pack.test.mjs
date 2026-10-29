import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FILES, HUB_ID, FOLDER_NAME, MAX_BYTES, sourcePaths, generateKnowledge, publishKnowledge, installKnowledge, installDir, runKnowledgePack, validateManifest } from './knowledge-pack.mjs';
import { redactForShare } from './lib/share-content.mjs';
import { syncKnowledge, build } from './onboarding-sync.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-pack-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const roots = sourcePaths(home);
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(path.join(roots.booth, 'CLAUDE.md'), '# 制作\n大事な規則 _value_ [参照] と日本語\n');
  put(path.join(roots.sales, 'docs', 'spec.md'), '# 営業\n仕様\n');
  put(path.join(roots.memory, 'index', 'booth.md'), '# 索引\n[安全](../safe.md)\n[共有禁止の説明](../private.md)\n[危険](../key.md)\n[範囲外](../../escape.md)\n[[wiki]]\n');
  put(path.join(roots.memory, 'safe.md'), '資格情報は sk-' + 'Z'.repeat(30) + '\nhttps://discord.com/api/webhooks/123/SECRET_HOOK\n' + 'a'.repeat(40));
  put(path.join(roots.memory, 'private.md'), '---\nmetadata:\n  share: false # non-shareable\n---\nNEVER_SHARE\n');
  put(path.join(roots.memory, 'key.md'), '-----BEGIN RSA PRIVATE KEY-----\nNEVER_PRIVATE_KEY');
  put(path.join(roots.memory, 'wiki.md'), 'wiki reference body');
  put(path.join(roots.playbooks, '作業.md'), '作業手順');
  const outDir = path.join(home, 'output');
  return { home, roots, put, outDir };
}
function fakeDrive() {
  const store = new Map(); let sequence = 0; const writes = [];
  const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const apiFn = async (_token, input, opts = {}) => {
    const url = new URL(input); const method = opts.method || 'GET';
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q');
      const name = /name='([^']+)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      return response({ files: [...store.values()].filter(x => x.name === name && x.parent === parent).map(x => ({ id: x.id, name: x.name, mimeType: x.mimeType })) });
    }
    const id = url.pathname.split('/').at(-1);
    if (method === 'GET' && url.searchParams.get('alt') === 'media') {
      assert.ok(store.has(id), `missing ${id}`); return new Response(store.get(id).bytes);
    }
    writes.push({ url: input, method });
    if (method === 'POST' && url.pathname === '/drive/v3/files') {
      const meta = JSON.parse(opts.body); const id = `folder-${++sequence}`;
      store.set(id, { id, name: meta.name, parent: meta.parents[0], mimeType: meta.mimeType }); return response({ id });
    }
    if (method === 'PATCH') { store.get(id).bytes = Buffer.from(opts.body); return response({ id }); }
    if (method === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
      const parts = opts.body.split('--x-claude-hub-sync');
      const meta = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
      const bytes = Buffer.from(parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2));
      const id = `file-${++sequence}`;
      store.set(id, { id, name: meta.name, parent: meta.parents[0], mimeType: 'text/plain', bytes }); return response({ id });
    }
    throw Error(`unexpected request ${method} ${input}`);
  };
  return { store, writes, apiFn, token: 'test-token', emit: () => {} };
}
test('redacts shared credentials, excludes opt-out and private keys including index descriptions, logs missing sources', t => {
  const f = fixture(t); const logs = [];
  const result = generateKnowledge({ ...f, emit: x => logs.push(x) });
  assert.deepEqual([...result.contents.keys()], FILES);
  const text = [...result.contents.values()].join('\n');
  assert.doesNotMatch(text, /Z{30}|SECRET_HOOK|a{40}|NEVER_SHARE|共有禁止の説明|NEVER_PRIVATE_KEY|BEGIN RSA/);
  assert.match(text, /REDACTED/); assert.match(text, /wiki reference body/);
  assert.ok(logs.some(x => x.includes('スキップ(欠落)')));
  assert.ok(logs.some(x => x.includes('除外(共有拒否)')));
  assert.ok(logs.some(x => x.includes('除外(資格情報)')));
});
test('UTF-8 limits include headers and all source references; generatedAt remains stable on reruns', t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.put(path.join(f.roots.booth, 'docs', `spec-${i}.md`), '制作😀営業\n'.repeat(20000));
  const first = generateKnowledge({ ...f, now: new Date('2026-10-01'), emit: () => {} });
  for (const [name, bytes] of first.contents) {
    assert.ok(bytes.length <= (name === FILES[0] ? 3000 : MAX_BYTES), `${name}: ${bytes.length}`);
    assert.doesNotMatch(bytes.toString(), /�/);
    assert.match(bytes.toString(), /生成日時:.*\nソースパス:/);
  }
  const production = first.contents.get(FILES[1]).toString();
  for (let i = 0; i < 30; i++) assert.ok(production.includes(`spec-${i}.md`));
  assert.match(production, /全文はソース/);
  const second = generateKnowledge({ ...f, now: new Date('2026-10-02'), emit: () => {} });
  for (const name of FILES) assert.deepEqual(second.contents.get(name), first.contents.get(name));
});
test('dry-run writes only output, never authenticates or installs', async t => {
  const f = fixture(t);
  await runKnowledgePack({ ...f, dryRun: true, apiFn: () => { throw Error('network must not be called'); }, emit: () => {} });
  assert.deepEqual(fs.readdirSync(f.outDir), FILES);
  assert.equal(fs.existsSync(installDir(f.home)), false);
});
test('publish preserves file IDs and skips unchanged content even with lost local cache; pull verifies bytes and uses receiver branch', async t => {
  const f = fixture(t); const drive = fakeDrive();
  const generated = generateKnowledge({ ...f, now: new Date('2026-10-01'), emit: () => {} });
  const first = await publishKnowledge({ ...generated, ...drive });
  assert.equal(first.updated, 7);
  assert.equal(drive.store.get(first.folderId).parent, HUB_ID);
  assert.equal(drive.store.get(first.folderId).name, FOLDER_NAME);
  const ids = first.manifest.files.map(f => f.id); const writeCount = drive.writes.length;
  fs.rmSync(f.outDir, { recursive: true });
  const fresh = generateKnowledge({ ...f, now: new Date('2026-10-02'), emit: () => {} });
  const second = await publishKnowledge({ ...fresh, ...drive });
  assert.equal(second.updated, 0); assert.equal(second.unchanged, 7);
  assert.equal(drive.writes.length, writeCount); assert.deepEqual(second.manifest.files.map(f => f.id), ids);
  const installed = await syncKnowledge({ targetHome: f.home, forced: true, receiver: true, emit: () => {}, install: options => installKnowledge({ ...options, ...drive }) });
  assert.equal(installed.source, false); assert.equal(installed.updated, 7);
  for (const name of FILES) assert.deepEqual(fs.readFileSync(path.join(installDir(f.home), name)), generated.contents.get(name));
  const repeat = await installKnowledge({ home: f.home, source: false, ...drive });
  assert.equal(repeat.updated, 0);
  f.put(path.join(f.roots.sales, 'docs', 'spec.md'), 'changed specification');
  const changed = generateKnowledge({ ...f, now: new Date('2026-10-03'), emit: () => {} });
  const third = await publishKnowledge({ ...changed, ...drive });
  assert.equal(third.updated, 1); assert.deepEqual(third.manifest.files.map(f => f.id), ids);
});
test('receiver rejects corrupt downloads without replacing existing files or advancing success state', async t => {
  const f = fixture(t); const drive = fakeDrive();
  const generated = generateKnowledge({ ...f, emit: () => {} });
  const published = await publishKnowledge({ ...generated, ...drive });
  f.put(path.join(installDir(f.home), FILES[0]), 'keep previous index');
  drive.store.get(published.manifest.files.at(-1).id).bytes = Buffer.from('corrupt');
  await assert.rejects(installKnowledge({ home: f.home, source: false, ...drive }), /integrity mismatch/);
  assert.equal(fs.readFileSync(path.join(installDir(f.home), FILES[0]), 'utf8'), 'keep previous index');
  const logs = [];
  await syncKnowledge({ targetHome: f.home, forced: true, receiver: true, emit: x => logs.push(x), install: options => installKnowledge({ ...options, ...drive }) });
  assert.ok(logs.some(x => x.includes('failed')));
  assert.equal(fs.existsSync(path.join(f.home, '.claude', '.knowledge-sync-state.json')), false);
});
test('manifest rejects traversal, duplicate/missing files and excessive sizes', () => {
  const valid = { version: 1, files: FILES.map((name, i) => ({ name, id: `id-${i}`, sha256: hash('x'), bytes: 1 })) };
  assert.equal(validateManifest(valid), valid);
  for (const patch of [{ name: '../escape.md' }, { bytes: 60001 }, { id: '../evil' }, { sha256: 'bad' }]) {
    const bad = structuredClone(valid); Object.assign(bad.files[1], patch); assert.throws(() => validateManifest(bad));
  }
  const bad = structuredClone(valid); bad.files[1] = bad.files[0]; assert.throws(() => validateManifest(bad));
});
test('source copies local output without Drive calls; compact instructions point to index without autoloading', async t => {
  const f = fixture(t);
  const result = await installKnowledge({ home: f.home, apiFn: () => { throw Error('no Drive call'); }, emit: () => {} });
  assert.equal(result.source, true); assert.equal(result.updated, 7);
  const compact = build(null, '# index', 'today').updated;
  assert.match(compact, /knowledge\/production-sales\/00_INDEX.md/);
  assert.doesNotMatch(compact, /@~\/\.claude\/knowledge/);
});
test('Drive upload errors propagate to job failure and never publish a new manifest', async t => {
  const f = fixture(t); const drive = fakeDrive();
  const generated = generateKnowledge({ ...f, emit: () => {} });
  const apiFn = (token, url, opts = {}) => {
    if (url.includes('/upload/')) throw Error('upload unavailable');
    return drive.apiFn(token, url, opts);
  };
  await assert.rejects(publishKnowledge({ ...generated, ...drive, apiFn }), /upload unavailable/);
  assert.equal([...drive.store.values()].some(x => x.name === 'manifest.json'), false);
});


test('shared redaction covers composite env names and quoted JSON credential fields', () => {
  const input = 'DISCORD_BOT_TOKEN=privateBotValue\n"refresh_token": "privateRefreshValue"\nCUSTOM_API_KEY=privateApiValue\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz';
  assert.doesNotMatch(redactForShare(input), /privateBotValue|privateRefreshValue|privateApiValue|abcdefghijklmnopqrstuvwxyz/);
});


test('all missing sources are logged in dry-run but cannot replace the published pack', async t => {
  const f = fixture(t);
  await assert.rejects(runKnowledgePack({ home: f.home, sourceHome: path.join(f.home, 'missing'), outDir: f.outDir, emit: () => {}, apiFn: () => { throw Error('must not access Drive'); } }), /ソースが0件/);
});


test('receiver authenticates through the existing approved Drive scope, without requesting an unapproved readonly scope', async t => {
  const f = fixture(t); const drive = fakeDrive();
  const generated = generateKnowledge({ ...f, emit: () => {} });
  await publishKnowledge({ ...generated, ...drive });
  let authenticated = false;
  await installKnowledge({ home: f.home, source: false, ...drive, token: undefined, getToken: async options => {
    assert.equal(options.scope, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    authenticated = true;
    return drive.token;
  } });
  assert.equal(authenticated, true);
});
