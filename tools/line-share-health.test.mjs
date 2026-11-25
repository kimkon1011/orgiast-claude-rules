import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, latestExportAge, runHealth } from './line-share-health.mjs';
const healthy = async url => {
  const u = new URL(url);
  if (u.pathname === '/manifest.json') return Response.json({ share_target: {} });
  if (u.search) return Response.json({ ok: true, probe: 'line-share-health-v1' });
  return new Response(null, { status: 303, headers: { location: '/?share_error=auth' } });
};
test('probe validates actual redirect and authenticated marker', async () => {
  assert.deepEqual(await probe({ base: 'https://example.test', token: 'test', fetchImpl: healthy }), []);
  assert.equal((await probe({ base: 'https://example.test', token: '', fetchImpl: healthy }))[0].key, 'authenticated');
  const bad = async () => new Response('login', { status: 200 });
  assert.equal((await probe({ base: 'https://example.test', token: 'test', fetchImpl: bad })).length, 3);
});
test('age ignores malformed rows and uses export-stored only', () => {
  assert.equal(latestExportAge('bad\n'+JSON.stringify({kind:'export-stored',ts:1000})+'\n'+JSON.stringify({kind:'export-rejected',ts:2000}),86401000),1);
  assert.equal(latestExportAge('',1000),null);
});
test('single recovery, 6h per-anomaly cooldown, stale exports do not restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'line-share-health-'));
  try {
    let messages=0, restarts=0;
    const options={ base:'https://example.test',token:'test',home:dir,stateFile:path.join(dir,'state'),debugFile:path.join(dir,'debug'),now:1e12,fetchImpl:healthy,sendDm:async()=>{messages++;},restart:async()=>{restarts++;} };
    await runHealth(options); assert.equal(messages,1);assert.equal(restarts,0);
    await runHealth({...options,now:options.now+3600000});assert.equal(messages,1);
    await runHealth({...options,now:options.now+6*3600000});assert.equal(messages,2);
    const failing={...options,fetchImpl:async()=>{throw new Error('offline');}};
    await runHealth(failing);assert.equal(restarts,1);assert.equal(messages,3);
    await runHealth({...failing,now:options.now+3600000});assert.equal(restarts,1);assert.equal(messages,3);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('recovered service does not send an outage alert; failed DM does not consume cooldown', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'line-share-health-'));
  try {
    const now=1e12; fs.writeFileSync(path.join(dir,'debug'),JSON.stringify({kind:'export-stored',ts:now}));
    let recovered=false, sent=0;
    const options={base:'https://example.test',token:'test',home:dir,stateFile:path.join(dir,'state'),debugFile:path.join(dir,'debug'),now,fetchImpl:async u=>{if(!recovered)throw new Error('offline');return healthy(u);},restart:async()=>{recovered=true;},sendDm:async()=>{sent++;}};
    assert.deepEqual((await runHealth(options)).problems,[]);assert.equal(sent,0);
    fs.writeFileSync(path.join(dir,'debug'),'');
    await assert.rejects(runHealth({...options,sendDm:async()=>{throw new Error('DM failed');}}));
    assert.equal(JSON.parse(fs.readFileSync(options.stateFile)).sent['stale-export'],undefined);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
