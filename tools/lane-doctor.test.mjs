import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { laneDoctorQuick, laneDoctorProbe, atomicJson, notificationText, freshProbe } from './lane-doctor.mjs';
const now = Date.parse('2026-10-08T06:00:00Z');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(path.join(home, '.codex'));
  const token = `x.${Buffer.from(JSON.stringify({ email: 'test@example.com' })).toString('base64url')}.x`;
  atomicJson(path.join(home, '.codex/auth.json'), { tokens: { id_token: token } });
  for (const [file, key] of [['gemini','GEMINI'],['deepseek','DEEPSEEK'],['zai','ZAI'],['groq','GROQ'],['openrouter','OPENROUTER']]) fs.writeFileSync(path.join(home, `.claude/${file}.env`), `${key}_API_KEY=test-fixture\n`);
  return home;
}
const write = (h, f, s) => atomicJson(path.join(h, '.claude', f), s);
const read = (h, f) => JSON.parse(fs.readFileSync(path.join(h, '.claude', f)));
test('quick removes expired demote/cooldown atomically, preserves unrelated providers and reads history', t => {
  const h = fixture(t);
  write(h, 'routing-overrides.json', { extra: 7, demote: { codex: new Date(now - 1).toISOString(), groq: new Date(now + 1000).toISOString() } });
  write(h, 'provider-cooldown.json', { codex: { until: now - 1 }, kimi: { until: now + 1000 } });
  fs.writeFileSync(path.join(h,'.claude/provider-limit-history.jsonl'), JSON.stringify({provider:'glm', until:now+1000,reason:'usage_limit'})+'\n');
  const result = laneDoctorQuick({ home: h, now });
  assert.equal(result.repairs.length, 2); assert.equal(result.lanes.codex.alive, true);
  assert.equal(result.lanes.glm.alive, false); assert.equal(result.lanes.groq.alive, false);
  assert.equal(read(h,'routing-overrides.json').extra, 7); assert.ok(read(h,'provider-cooldown.json').kimi);
  assert.deepEqual(result.implementOrder.slice(0,2), ['codex','deepseek']);
  assert.ok(!JSON.stringify(result).includes('test-fixture'));
});
test('probe repairs healthy demotes, classifies payment and rate limits, caches Codex and dedupes DM', async t => {
  const h = fixture(t); let codexTasks = 0, notifications = 0;
  write(h,'routing-overrides.json',{demote:{codex:new Date(now+100000).toISOString(),groq:new Date(now+100000).toISOString()}});
  const probe = async (p, options) => {
    if(p==='codex' && !options.dryRun) codexTasks++;
    return p==='gemini' ? {code:1,text:'HTTP 402 prepayment credits are depleted'} : p==='glm' ? {code:1,text:'HTTP 429 retry in 10 minutes'} : {code:0,text:'PONG'};
  };
  const notify = async text => { notifications++; assert.match(text,/kim@orgiast.jp/); assert.match(text,/オートチャージ ON/); return {delivered:'dm'}; };
  const result = await laneDoctorProbe({home:h,now,probe,notify});
  assert.equal(result.lanes.gemini.reason,'dead:payment_required'); assert.equal(result.lanes.codex.alive,true);
  assert.deepEqual(read(h,'routing-overrides.json').demote,{}); assert.equal(result.lanes.glm.until,now+600000);
  await laneDoctorProbe({home:h,now:now+60000,probe,notify}); assert.equal(codexTasks,1); assert.equal(notifications,1);
  await laneDoctorProbe({home:h,now:now+86400001,probe,notify}); assert.equal(codexTasks,2); assert.equal(notifications,2);
});
test('quick preserves payment failure and cannot refresh probe timestamp', async t => {
  const h=fixture(t); write(h,'lane-health.json',{probedAt:new Date(now-3600000).toISOString(),lanes:{gemini:{alive:false,reason:'dead:payment_required'}}});
  const r=laneDoctorQuick({home:h,now}); assert.equal(r.lanes.gemini.alive,false); assert.equal(freshProbe(r.probedAt,now),false);
});
test('corrupt routing is not silently overwritten',t=>{const h=fixture(t);fs.writeFileSync(path.join(h,'.claude/routing-overrides.json'),'{broken');assert.throws(()=>laneDoctorQuick({home:h,now}));assert.equal(fs.readFileSync(path.join(h,'.claude/routing-overrides.json'),'utf8'),'{broken');});
test('notification reports key owner only from comments',t=>{const h=fixture(t);fs.appendFileSync(path.join(h,'.claude/gemini.env'),'# owner: owner@example.com\n');const text=notificationText({provider:'gemini',reason:'dead:payment_required'},h);assert.match(text,/owner@example.com/);assert.ok(!text.includes('test-fixture'));});
test('successful probe supersedes older limit history; expired cooldown cache does not revive',t=>{
  const h=fixture(t),stamp=new Date(now-1000).toISOString();
  fs.writeFileSync(path.join(h,'.claude/provider-limit-history.jsonl'),JSON.stringify({provider:'deepseek',t:new Date(now-2000).toISOString(),until:now+3600000})+'\n');
  write(h,'lane-health.json',{lanes:{deepseek:{alive:true,reason:'probe_ok',probedAt:stamp},glm:{alive:false,reason:'cooldown',until:now-1,probedAt:stamp}}});
  const r=laneDoctorQuick({home:h,now});assert.equal(r.lanes.deepseek.alive,true);assert.equal(r.lanes.glm.alive,true);
});
test('failed notification is retried, while successful delivery is deduped',async t=>{
  const h=fixture(t);let calls=0;
  const probe=async p=>p==='gemini'?{code:1,text:'HTTP 402'}:{code:0,text:'PONG'};
  const notify=async()=>{calls++;return {delivered:calls===1?'none':'dm'};};
  for(let i=0;i<3;i++)await laneDoctorProbe({home:h,now:now+i*1000,probe,notify});
  assert.equal(calls,2);
});
