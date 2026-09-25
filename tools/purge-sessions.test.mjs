import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dropClosed } from './purge-sessions.mjs';
const dir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(dir, 'purge-sessions.mjs');
const now = Date.now(), minute = 60_000;
const msg = (type, content, age = 20 * minute) => ({ type, message: { content }, timestamp: new Date(now - age).toISOString() });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-sessions-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  const put = (name, data) => { const p = path.join(base, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
  const env = { ...process.env, HOME: home, USERPROFILE: home, ORGIAST_HOME: home, ORGIAST_REPO: path.dirname(dir) };
  const run = (...args) => { const r = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 10_000 }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const session = (id, rows, age = 20 * minute) => { const raw = rows.map(x => JSON.stringify(x)).join('\n') + '\n'; const p = put(`projects/project/${id}.jsonl`, raw); fs.utimesSync(p, new Date(now - age), new Date(now - age)); return raw; };
  return { home, base, put, env, run, session };
}
test('a-d archive by the correct clocks; active set and recent meaningful sessions survive; restore is lossless', t => {
  const f = fixture(t), expected = new Map();
  expected.set('closed', f.session('closed', [msg('user', 'closed title')], 46_000));
  expected.set('empty', f.session('empty', [msg('user', '<command-name>/clear</command-name>')], 91_000));
  expected.set('approved', f.session('approved', [msg('user', 'approved title'), msg('assistant', 'このセッション: アーカイブしてよい')], 0));
  expected.set('abandoned', f.session('abandoned', [msg('user', 'old task', 74*60*minute), msg('assistant', '次に kim がすること\n確認する\nこの後の自動進行\nテストする', 73*60*minute)], 0));
  f.put('projects/project/abandoned/subagents/worker.jsonl', 'preserved companion');
  const keep = ['active-empty', 'active-closed', 'active-approved', 'active-abandoned', 'fresh', 'not-ready', 'user-after', 'image-after', 'large-empty', 'broken', 'no-timestamp'];
  f.session('active-empty', []);
  f.session('active-closed', [msg('user', 'work')]);
  f.session('active-approved', [msg('assistant', 'このセッション: アーカイブしてよい')]);
  f.session('active-abandoned', [msg('user', 'work', 80*60*minute)]);
  for (const id of keep.filter(x => x.startsWith('active-'))) f.put(`current-sessions/${id}.json`, JSON.stringify({ sessionId: id, at: new Date(now).toISOString() }));
  f.session('fresh', [msg('user', 'fresh', 0)], 0);
  f.session('not-ready', [msg('assistant', 'このセッション: まだアーカイブしない')]);
  f.session('user-after', [msg('assistant', 'このセッション: アーカイブしてよい'), msg('user', 'continue')]);
  f.session('image-after', [msg('assistant', 'このセッション: アーカイブしてよい'), msg('user', [{ type: 'image', source: {} }])]);
  f.session('large-empty', [{ type: 'system', padding: 'x'.repeat(200_001) }]);
  const broken = f.put('projects/project/broken.jsonl', '{broken'); fs.utimesSync(broken, new Date(0), new Date(0));
  f.session('no-timestamp', [{ type: 'user', message: { content: 'do not infer age from mtime' } }], 100*60*minute);
  f.put('closed-sessions.json', JSON.stringify({ ids: ['closed', 'active-closed'], extra: true }));
  const dry = f.run('--dry-run');
  assert.deepEqual(dry.sessions.map(x=>x.reason).sort(), ['abandoned', 'approved', 'closed', 'empty']);
  assert.equal(fs.existsSync(path.join(f.base, 'purge-sessions-state.json')), false);
  assert.equal(fs.existsSync(path.join(f.base, 'purge-sessions.lock')), false);
  for (const id of expected.keys()) assert.ok(fs.existsSync(path.join(f.base, `projects/project/${id}.jsonl`)));
  const result = f.run();
  assert.equal(result.sessions.length, 4);
  for (const [id, raw] of expected) {
    assert.equal(fs.existsSync(path.join(f.base, `projects/project/${id}.jsonl`)), false);
    assert.equal(fs.readFileSync(path.join(f.base, `projects-archive/project/${id}.jsonl`), 'utf8'), raw);
  }
  for (const id of keep) assert.ok(fs.existsSync(path.join(f.base, `projects/project/${id}.jsonl`)), id);
  const rows = fs.readFileSync(path.join(f.base, 'archived-sessions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 4);
  assert.match(rows.find(x=>x.reason==='abandoned').nextKim, /確認する/);
  assert.match(rows.find(x=>x.reason==='abandoned').automatic, /テストする/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.base, 'closed-sessions.json'))), { ids: ['active-closed'], extra: true });
  assert.equal(f.run().skipped, 'cooldown');
  assert.equal(f.run('--restore', 'abandoned').restored, 'abandoned');
  assert.equal(fs.readFileSync(path.join(f.base, 'projects/project/abandoned.jsonl'), 'utf8'), expected.get('abandoned'));
  assert.equal(fs.readFileSync(path.join(f.base, 'projects/project/abandoned/subagents/worker.jsonl'), 'utf8'), 'preserved companion');
  assert.equal(f.run('--dry-run').sessions.some(x=>x.sessionId==='abandoned'), false);
});
test('live lock skips; dead PID is reclaimed; destination collision preserves both originals', t => {
  const f = fixture(t);
  const raw = f.session('collision', []);
  f.put('projects-archive/project/collision.jsonl', 'existing archive');
  f.put('purge-sessions.lock', JSON.stringify({ pid: process.pid }));
  assert.equal(f.run().skipped, 'locked');
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  f.put('purge-sessions.lock', JSON.stringify({ pid: dead.pid }));
  const result = f.run();
  assert.equal(result.errors.length, 1);
  assert.equal(fs.readFileSync(path.join(f.base, 'projects/project/collision.jsonl'), 'utf8'), raw);
  assert.equal(fs.readFileSync(path.join(f.base, 'projects-archive/project/collision.jsonl'), 'utf8'), 'existing archive');
  assert.equal(fs.existsSync(path.join(f.base, 'purge-sessions.lock')), false);
});
test('subtracting closed IDs rereads the ledger and preserves concurrent additions', t => {
  const f = fixture(t);
  f.put('closed-sessions.json', JSON.stringify({ ids: ['old', 'new'], metadata: 'keep' }));
  dropClosed(f.base, new Set(['old']));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.base, 'closed-sessions.json'))), { ids: ['new'], metadata: 'keep' });
});
test('file cap rotates the cursor so retained sessions cannot starve later files', t => {
  const f = fixture(t);
  for (let i=0;i<501;i++) f.session(`s${String(i).padStart(3,'0')}`, [msg('user','fresh',0)], 0);
  f.session('z-empty', []);
  const first = f.run();
  assert.equal(first.scanned, 500); assert.equal(first.limited, true);
  const state = JSON.parse(fs.readFileSync(path.join(f.base, 'purge-sessions-state.json')));
  f.put('purge-sessions-state.json', JSON.stringify({ ...state, at: now - 6*minute }));
  assert.equal(f.run().sessions[0].sessionId, 'z-empty');
});
test('hook returns while stdin is open, launches one shot and honors cooldown', async t => {
  const f = fixture(t); f.session('empty', []);
  const start = Date.now();
  const child = spawn(process.execPath, [script, '--hook'], { env: f.env, stdio: ['pipe','pipe','pipe'] });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
  assert.ok(Date.now() - start < 3000);
  const state = path.join(f.base, 'purge-sessions-state.json');
  for (let i=0; i<100 && !fs.existsSync(state); i++) await new Promise(r=>setTimeout(r,20));
  assert.ok(fs.existsSync(state));
  assert.ok(fs.existsSync(path.join(f.base, 'projects-archive/project/empty.jsonl')));
  const before = fs.readFileSync(state,'utf8');
  const hook = spawnSync(process.execPath, [script, '--hook'], {env:f.env,encoding:'utf8'});
  assert.equal(hook.status, 0); assert.equal(hook.stdout, '');
  assert.equal(fs.readFileSync(state,'utf8'), before);
});
test('setup converge repairs both events on existing PCs and remains idempotent', t => {
  const f=fixture(t);
  f.put('settings.json',JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'python "frozen/purge-hidden-sessions.py" --start-watcher'},{type:'command',command:'echo keep'}]}], Stop:[{hooks:[{type:'command',command:'node "frozen/purge-closed-sessions.mjs"'}]}], UserPromptSubmit:[{hooks:[{type:'command',command:'node "frozen/session-list-tidy.mjs"'}]}]}}));
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'setup-manifest.json')));
  const file=f.put('test-manifest.json',JSON.stringify({...manifest,items:manifest.items.filter(x=>x.id.startsWith('settings:purge-sessions-'))}));
  const args=[path.join(dir,'setup.mjs'),'--converge','--home',f.home,'--manifest',file,'--json'];
  const run=()=>{const r=spawnSync(process.execPath,args,{env:f.env,encoding:'utf8',timeout:30_000});assert.equal(r.status,0,r.stderr+r.stdout);return JSON.parse(r.stdout);};
  run();
  const settingsFile=path.join(f.base,'settings.json');
  const settings=JSON.parse(fs.readFileSync(settingsFile));
  for(const event of ['SessionStart','Stop']) {
    const hooks=settings.hooks[event].flatMap(x=>x.hooks).filter(x=>x.command.includes('purge-sessions.mjs'));
    assert.equal(hooks.length,1); assert.ok(hooks[0].command.includes(path.join(dir,'purge-sessions.mjs'))); assert.ok(hooks[0].command.endsWith(' --hook'));
  }
  assert.doesNotMatch(JSON.stringify(settings),/purge-hidden-sessions|purge-closed-sessions|session-list-tidy/);
  assert.match(JSON.stringify(settings),/echo keep/);
  const before=fs.readFileSync(settingsFile,'utf8');
  run(); assert.equal(fs.readFileSync(settingsFile,'utf8'),before);
  settings.hooks.Stop=settings.hooks.Stop.filter(x=>!x.hooks.some(h=>h.command.includes('purge-sessions')));
  fs.writeFileSync(settingsFile,JSON.stringify(settings));
  assert.ok(run().items.every(x=>x.status === 'OK'));
  assert.ok(JSON.parse(fs.readFileSync(settingsFile)).hooks.Stop.some(x=>x.hooks.some(h=>h.command.includes('purge-sessions.mjs'))));
});
test('dry-run pagination is read-only and reaches every file beyond the cap', t => {
  const f=fixture(t);
  for(let i=0;i<503;i++) f.session(`s${String(i).padStart(3,'0')}`, []);
  const first=f.run('--dry-run');
  assert.equal(first.scanned,500); assert.equal(first.limited,true);
  const second=f.run('--dry-run','--after',first.nextCursor);
  assert.equal(second.scanned,3); assert.equal(second.limited,false);
  assert.equal(new Set([...first.sessions,...second.sessions].map(x=>x.sessionId)).size,503);
  assert.equal(fs.existsSync(path.join(f.base,'purge-sessions-state.json')),false);
  assert.equal(fs.existsSync(path.join(f.base,'projects-archive')),false);
});
test('failed audit append rolls the transcript and its companion directory back', t => {
  const f=fixture(t),raw=f.session('rollback',[]);
  f.put('projects/project/rollback/subagents/worker.jsonl','worker');
  fs.mkdirSync(path.join(f.base,'archived-sessions.jsonl'));
  const result=f.run();
  assert.equal(result.sessions.length,0); assert.equal(result.errors.length,1);
  assert.equal(fs.readFileSync(path.join(f.base,'projects/project/rollback.jsonl'),'utf8'),raw);
  assert.equal(fs.readFileSync(path.join(f.base,'projects/project/rollback/subagents/worker.jsonl'),'utf8'),'worker');
});
test('only the final assistant approval counts, and a fresh final JSONL timestamp prevents c/d', t => {
  const f=fixture(t);
  f.session('withdrawn',[msg('assistant','このセッション: アーカイブしてよい'),msg('assistant','このセッション: まだアーカイブしない')]);
  f.session('recent',[msg('assistant','このセッション: アーカイブしてよい'),{type:'progress',timestamp:new Date(now).toISOString()}],80*60*minute);
  f.session('old-not-ready',[msg('assistant','このセッション: まだアーカイブしない',80*60*minute)],0);
  assert.deepEqual(f.run().sessions.map(x=>[x.sessionId,x.reason]),[['old-not-ready','abandoned']]);
});
test('concurrent invocations archive a session exactly once', async t => {
  const f=fixture(t);const raw=f.session('parallel',[]);
  const results=await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script],{env:f.env,stdio:['ignore','pipe','pipe']});let output='',error='';
    child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);child.on('error',reject);
    child.on('exit',code=>code===0?resolve(JSON.parse(output)):reject(new Error(error)));
  })));
  assert.equal(results.flatMap(x=>x.sessions).length,1);
  assert.equal(fs.readFileSync(path.join(f.base,'projects-archive/project/parallel.jsonl'),'utf8'),raw);
  assert.equal(fs.readFileSync(path.join(f.base,'archived-sessions.jsonl'),'utf8').trim().split('\n').length,1);
});
test('large transcripts use UTF-8-safe reverse reads and retain the latest handoff sections', t => {
  const f=fixture(t),old=80*60*minute;
  const padding={type:'system',padding:'あ'.repeat(100_000),timestamp:new Date(now-old).toISOString()};
  const title='題'.repeat(70);
  const raw=f.session('large-old',[msg('user',title,old),padding,msg('assistant','次に kim がすること\n古い手順\nこの後の自動進行\n古い進行',old),msg('assistant','次に kim がすること\n最新手順\nこの後の自動進行\n最新進行',old)],0);
  f.session('large-approved',[msg('user','approved'),padding,msg('assistant','このセッション: アーカイブしてよい')],0);
  f.session('large-user-after',[msg('user','start'),padding,msg('assistant','このセッション: アーカイブしてよい'),msg('user','continue')],0);
  const result=f.run();
  assert.deepEqual(result.sessions.map(x=>x.sessionId).sort(),['large-approved','large-old']);
  const row=result.sessions.find(x=>x.sessionId==='large-old');
  assert.equal([...row.title].length,60);assert.match(row.nextKim,/最新手順/);assert.match(row.automatic,/最新進行/);
  assert.doesNotMatch(row.nextKim,/古い/);
  assert.equal(fs.readFileSync(path.join(f.base,'projects-archive/project/large-old.jsonl'),'utf8'),raw);
});
