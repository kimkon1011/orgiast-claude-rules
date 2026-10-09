import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { webSearch, searchLeaks, askJson } from './leak-search.mjs';
import { refreshPatterns } from './patterns-refresh.mjs';
test('web CLI string URLs supported and shell-safe argv',async()=>{let args;const r=await webSearch('test; $(cmd)',async(c,a)=>{args=a;return JSON.stringify({answer:'summary',urls:['https://example.invalid/a']})});assert.equal(r.length,1);assert.equal(args[1],'test; $(cmd)');assert.equal(r[0].snippet,'summary');});
test('LLM explicitly deepseek with no fallback',async()=>{let args;await askJson('test',async(c,a)=>{args=a;return '{}'});assert.ok(args.includes('deepseek'));assert.ok(args.includes('--no-fallback'));});
test('leak classification/dedup and failure not marked seen',async()=>{
 const opts={search:async()=>[{url:'https://example.invalid/leak',title:'x',snippet:'y'}],run:async()=>{throw Error('gh unavailable')},ask:async()=>({verdict:'yes',reason:'evidence'})};const r=await searchLeaks(opts);assert.equal(r.findings.length,1);assert.equal(r.findings[0].severity,'high');assert.equal((await searchLeaks({...opts,state:{knownLeakUrls:r.knownLeakUrls}})).findings.length,0);
 const failed=await searchLeaks({...opts,ask:async()=>{throw Error('bad')}});assert.equal(failed.knownLeakUrls.length,0);assert.equal(failed.sources['web:classification'].status,'failed');
});
test('pattern source URL must be grounded, name dedup, append without executing candidate',async t=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'ia-pattern-'));t.after(()=>fs.rm(stateDir,{force:true,recursive:true}));const candidate={id:'x',name:'Sample',category:'x',signal:'x',data_source:'x',rule_sketch:'x',source_url:'https://example.invalid/a'};
 const opts={stateDir,patterns:{patterns:[]},search:async()=>[{url:candidate.source_url,title:'a'}],ask:async()=>[candidate,{...candidate,name:'invented',source_url:'https://invented.invalid'}]};const r=await refreshPatterns(opts);assert.equal(r.candidates.length,1);assert.equal((await refreshPatterns(opts)).candidates.length,0);assert.equal((await fs.readFile(path.join(stateDir,'pattern-candidates.jsonl'),'utf8')).trim().split('\n').length,1);
});
test('empty public searches never establish absence of leaks',async()=>{
 const r=await searchLeaks({search:async()=>[],run:async()=>JSON.stringify({items:[]}),ask:async()=>{throw Error('no results to classify')}});assert.equal(r.sources.github.status,'unverified');assert.equal(r.sources['web:1'].status,'unverified');assert.equal(r.findings.length,0);
});

test('LLM JSON handles preamble, fences, nested brackets and escaped quotes', async () => {
  const value = { text: 'a \\" } ]', nested: [{ ok: true }] };
  assert.deepEqual(await askJson('test', async () => '前置き\n```json\n' + JSON.stringify(value) + '\n```\n末尾'), value);
});
test('LLM malformed JSON retries once, masks diagnostics and refresh reports failed', async t => {
  const calls = [];
  assert.deepEqual(await askJson('test', async (cmd, args) => { calls.push(args); return calls.length === 1 ? '{broken' : '[{"ok":true}]'; }), [{ ok: true }]);
  assert.match(calls[1].at(-1), /JSON のみを返せ/);
  let count = 0;
  await assert.rejects(askJson('test', async () => { count++; return 'Bearer secret-token ' + 'x'.repeat(100); }), e => !e.message.includes('secret-token') && e.message.includes('[AUTH REDACTED]'));
  assert.equal(count, 2);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ia-json-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const r = await refreshPatterns({ stateDir, patterns: { patterns: [] }, search: async () => [{ url: 'https://example.invalid' }], ask: p => askJson(p, async () => 'bad JSON') });
  assert.ok(Object.values(r.sources).every(s => s.status === 'failed'));
});
