import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, checkDraft } from './event-shop-reply-context.mjs';
const context = `## 2. 社内の返信案\n250,000円 180,000円 22,000円 452,000円 90,400円 542,400円 54,240円 596,640円 430,000円 86,000円 516,000円 51,600円 567,600円\n## 3. メール\n\n## 4. 商品\n| slug | name | price | unit |\n| --- | --- | --- | --- |\n| kakuzuke-check | 社員格付けチェック | 275,000 | 式 |\n| quiz-intro-don | クイズイントロドン | 110,000 | 式 |\n## 5. チェック\n`;
const bad = '社員格付けチェック　1式　275,000円\n予選企画（クイズイントロドン　ゲームスライド）　1式　11,000円〜\n小計　286,000円\n管理手数料（20%）　57,200円\n税抜合計　343,200円\n消費税（10%）　34,320円\n合計（税込）　377,520円';
const good = '社員格付けチェック 1式 250,000円\n予選企画 1式（A〜Cのいずれか） 180,000円\n往復送料（概算） 22,000円\n小計 452,000円\n管理手数料（20%） 90,400円\n税抜合計 542,400円\n消費税（10%） 54,240円\n合計（税込） 596,640円';
test('check: actual bad/good drafts and CLI exit', async () => {
  assert.equal(checkDraft(bad,context)[1].status,'NG');
  assert.ok(checkDraft(good,context).every(r=>r.status==='OK'));
  const dir = await mkdtemp(path.join(os.tmpdir(),'reply-check-'));
  try {
    await writeFile(path.join(dir,'context'),context);
    for (const [draft, expected] of [[bad,1],[good,0]]) {
      await writeFile(path.join(dir,'draft'),draft);
      assert.equal(await main({args:['check','--draft',path.join(dir,'draft'),'--context',path.join(dir,'context')],log:()=>{}}),expected);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('社内返信案の商品別・見出し語別の金額を優先する', () => {
  const c = context.replace('250,000円 180,000円', '社員格付けチェック 1式 250,000円\n予選企画 1式（A〜Cのいずれか） 180,000円');
  const rows = checkDraft('社員格付けチェック　1式　275,000円\n社員格付けチェック 1式 250,000円\n予選企画 1式（A〜Cのいずれか） 180,000円', c);
  assert.deepEqual(rows.map(r => r.status), ['WARN', 'OK', 'OK']);
  assert.match(rows[0].reason, /250,000/);
  assert.match(rows[0].reason, /商品定価と社内判断額が違う/);
  assert.equal(rows[1].reason, '社内返信案と一致');
  assert.equal(rows[2].reason, '社内返信案と一致');
  assert.equal(checkDraft('予選企画　1式（A〜Cのいずれか） 181,000円', c)[0].status, 'WARN');
  assert.equal(checkDraft('予選企画 1式（A〜Cのいずれか） 22,000円', c)[0].status, 'OK');
  assert.equal(checkDraft('社員格付けチェック 1式 999,000円', c)[0].status, 'NG');
});
test('calculation blocks, WARN, fullwidth and argument validation',async()=>{
  const c='## 2. 社内\n\n## 4. 商品\n| x | 商品 | 1,000 | 式 |\n## 5. end\n';
  assert.deepEqual(checkDraft('商品 １，０００円\n小計 1,000円\n手数料 200円\n税抜合計 1,200円\n消費税 120円\n合計 1,320円',c).map(r=>r.status),Array(6).fill('OK'));
  assert.equal(checkDraft('送料 999円',c)[0].status,'WARN');
  assert.equal(checkDraft('商品 1,000円\n\n小計 1,000円',c)[1].status,'WARN');
  for(const args of [[],['collect'],['collect','--lead','x'],['check','--draft','x'],['collect','--email','x','--days','0']]) assert.equal(await main({args,log:()=>{}}),64);
});
for(const forbidden of [false,true]) for (const inquiry of ['格付けチェックとクイズイントロドン', '縁日']) test(`collect mocked; Discord forbidden=${forbidden}; inquiry=${inquiry}`,async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'reply-collect-')), logs=[], calls=[];
  const json = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  let spawned=false;
  const fetchImpl=async(url,init)=>{
    calls.push([url,init]);
    if(url.includes('quote_requests?')) return json([{id:'12345678-abcd-1234-abcd-123456789012',company_name:'テスト会社',contact_name:'担当',email:'a@example.test',created_at:'2026-10-27',raw_payload:{message:inquiry, ai_reply_draft:'お問い合わせいただいた…概算のお見積り目安…', event_shop:{generated:{body:'自動生成された本文'}}, nested_ai:{message:'混入禁止'}, content:'ご案内いたします 混入禁止', 'ご希望商品':'縁日', draft:'絶対に出ない誤下書き',nested:{reply:'過去の誤返信'}}}]);
    if(url.includes('products?')) return json([{slug:'quiz-intro-don',name:'【人気】クイズイントロドン！',price_min:110000,unit:'式'},{slug:'kakuzuke-check',name:'社員格付けチェック',price_min:275000,unit:'式'},{slug:'game-slide',name:'ゲームスライド',price_min:11000},{slug:'ennichi',name:'縁日・夏祭りイベント企画｜屋台・ゲーム・かき氷',price_min:100000},{slug:'generic',name:'ゲーム',price_min:1000}]);
    if(url.includes('channel_messages?')) return json([{direction:'in',received_at:'2026-10-27',subject:'相談',body:'本文'}]);
    if(url==='https://attachment.test/file') return new Response('テスト会社 添付本文 180,000円 secret-token secret-key');
    assert.equal(init.headers.Authorization,'Bot secret-token');
    if(forbidden) return new Response('',{status:403});
    if(url.endsWith('/users/@me/channels')) return json({id:'dm'});
    return json([{id:'123',timestamp:'2026-10-27T00:00:00Z',author:{id:'kim-id',username:'kim'},content:'【返信案 1/2】テスト会社 250,000円',attachments:[{filename:'テスト会社.txt',size:100,url:'https://attachment.test/file'}]}, {id:'124',timestamp:'2026-10-27T00:05:00Z',author:{id:'kim-id',username:'kim'},content:'【返信案 2/2】管理手数料 86,000円'}, {id:'125',timestamp:'2026-10-27T00:05:00Z',author:{id:'other'},content:'他人の混入禁止'}, {id:'126',timestamp:'2026-10-27T00:40:00Z',author:{id:'kim-id'},content:'(2/2) 連番の追加 51,600円'}, {id:'127',timestamp:'2026-10-29T00:00:00Z',author:{id:'kim-id'},content:'2/2 期限外の混入禁止'}]);
  };
  try {
    const code=await main({home,args:['collect','--company','テスト会社'],now:new Date('2026-10-29'),env:{SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'secret-key',DISCORD_BOT_TOKEN:'secret-token'},fetchImpl,spawnSyncImpl:(exe,args,opts)=>{spawned=true;assert.ok(args.includes('a@example.test newer_than:60d'));assert.equal(opts.shell,false);assert.equal(opts.timeout,900000);return {status:0,stdout:JSON.stringify({messages:[{date:'today',from:'a',to:'b',subject:'mail',snippet:'snippet'}]})};},log:s=>logs.push(s)});
    assert.equal(code,0); assert.ok(spawned);
    const md=await readFile(path.join(home,'.claude/event-shop-reply-context/12345678/reply-context.md'),'utf8');
    assert.deepEqual([...md.matchAll(/^## (\d)\./gm)].map(m=>m[1]),['1','2','3','4','5']);
    assert.equal(/^\| quiz-intro-don \|/m.test(md), inquiry !== '縁日');assert.equal(/^\| kakuzuke-check \|/m.test(md), inquiry !== '縁日');
    assert.ok(/^\| ennichi \|/m.test(md));
    assert.equal(md.includes('(フォーム選択のみ)'), inquiry !== '縁日');
    assert.ok(md.includes(inquiry));
    for (const excluded of ['概算のお見積り目安', '自動生成された本文', '混入禁止']) assert.ok(!md.includes(excluded));
    assert.ok(!/^\| generic \|/m.test(md));
    assert.ok(!/^\| game-slide \|/m.test(md));
    assert.ok(!md.includes('絶対に出ない誤下書き'));assert.ok(!md.includes('過去の誤返信'));
    for(const secret of ['secret-key','secret-token']) assert.ok(!`${md}${logs.join('')}`.includes(secret));
    if(forbidden) assert.ok(md.includes('未確認（HTTP 403）')); else {assert.ok(md.includes('【返信案 1/2】'));assert.ok(md.includes('【返信案 2/2】管理手数料 86,000円'));assert.ok(md.includes('連番の追加 51,600円'));assert.ok(md.includes('添付本文'));assert.ok(md.includes('JST'));}
    assert.ok(!calls.some(([u])=>u.includes('threads')));
  } finally {await rm(home,{recursive:true,force:true});}
});

test('倉庫引取の全金額は見出し違いがあっても社内金額または計算で OK', async () => {
  const draft = '本体 430,000円\n小計 430,000円\n管理手数料 86,000円\n税抜合計 516,000円\n消費税 51,600円\n合計 567,600円';
  const conflicting = context.replace('250,000円 180,000円', '小計 452,000円\n管理手数料 90,400円\n税抜合計 542,400円\n消費税 54,240円\n合計 596,640円\n250,000円 180,000円');
  assert.ok(checkDraft(draft, conflicting).every(r => r.status === 'OK'));
  const calculated = conflicting.replace('430,000円 86,000円 516,000円 51,600円 567,600円', '430,000円');
  assert.ok(checkDraft(draft, calculated).every(r => r.status === 'OK'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reply-warehouse-'));
  try {
    await writeFile(path.join(dir, 'draft'), draft);
    await writeFile(path.join(dir, 'context'), conflicting);
    const logs = [];
    assert.equal(await main({ args: ['check', '--draft', path.join(dir, 'draft'), '--context', path.join(dir, 'context')], log: s => logs.push(s) }), 0);
    assert.equal(logs.length, 6);
    assert.ok(logs.every(s => s.includes('| OK |')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
