import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{customerPending,main,processThreads}from'./ai-daikodo-line-watch.mjs';
const thread={threadId:'t1',lineUserId:'Uabc',displayName:'顧客',messages:[{id:'m1',at:'2026-11-17T00:00:00Z',author:'customer',text:'質問です'}]};
test('scheduled watcher loads saved credentials and processes Blob threads despite Discord 403', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-auth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'ai-daikodo-line');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'tanom-admin.env'), 'TANOM_ADMIN_KEY=saved-test-key\nTANOM_BASE=https://example.test\n');
  fs.writeFileSync(path.join(dir, 'last-error.txt'), 'previous failure');
  const previous = '2026-11-17T10:00:00.000Z';
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastCheckedAt: previous }));
  const now = new Date('2026-11-17T13:00:00Z');
  const warnings = [], drafts = [], notices = [], requests = [];
  const code = await main({
    home, env: {}, now, warn: warning => warnings.push(warning),
    fetchImpl: async (url, init) => {
      requests.push(String(url));
      assert.equal(init.headers.Authorization, 'Bearer saved-test-key');
      assert.equal(init.method, undefined);
      assert.equal(init.redirect, 'error');
      assert.equal(new URL(url).searchParams.get('since'), previous);
      return Response.json({ threads: [thread], incomplete: true, warnings: [{ source: 'discord', status: 403 }] }, { status: 206 });
    },
    draft: async value => { drafts.push(value); return '確認してご連絡します。'; },
    notify: async value => { notices.push(value); },
  });
  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^https:\/\/example\.test\/api\/admin\/line\/inbox\?/);
  assert.deepEqual(drafts, [thread]);
  assert.equal(notices.length, 1);
  assert.match(fs.readFileSync(notices[0].file, 'utf8'), /確認してご連絡します/);
  assert.match(warnings[0], /discord HTTP 403/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), { lastCheckedAt: now.toISOString() });
  assert.equal(fs.existsSync(path.join(dir, 'last-error.txt')), false);
});
test('customer判定',()=>{assert.equal(customerPending(thread),true);assert.equal(customerPending({...thread,messages:[{...thread.messages[0],author:'staff'}]}),false);});
test('重複登録防止',async()=>{const h=fs.mkdtempSync(path.join(os.tmpdir(),'watch-'));let notices=0;const deps={home:h,draft:async()=> '返信案',notify:async()=>{notices++;}};assert.equal((await processThreads([thread],deps)).length,1);assert.equal((await processThreads([thread],deps)).length,0);assert.equal(notices,1);assert.ok(fs.existsSync(path.join(h,'.claude','ai-daikodo-line','drafts','t1-m1.txt')));});
test('Discord障害は警告扱いで state を更新',async()=>{const h=fs.mkdtempSync(path.join(os.tmpdir(),'watch-partial-'));const warnings=[];const now=new Date('2026-11-17T12:00:00Z');const exit=await main({home:h,now,warn:x=>warnings.push(x),line:async()=>({exitCode:2,body:{threads:[],incomplete:true,warnings:[{source:'discord',status:403}]}})});assert.equal(exit,0);assert.match(warnings[0],/discord HTTP 403/);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h,'.claude','ai-daikodo-line','state.json'),'utf8')),{lastCheckedAt:now.toISOString()});assert.equal(fs.existsSync(path.join(h,'.claude','ai-daikodo-line','last-error.txt')),false);});
