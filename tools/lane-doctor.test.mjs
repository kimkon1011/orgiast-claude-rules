import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { laneDoctorQuick, laneDoctorProbe, atomicJson, notificationText, freshProbe, summarize } from './lane-doctor.mjs';
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
  const notify = async text => { notifications++; assert.match(text,/kim@orgiast.jp/); assert.match(text,/Setup auto-reload/); return {delivered:'dm'}; };
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

for (const filename of ['provider-limit-history.jsonl', 'codex-limit-history.jsonl']) {
  test(`successful probe survives two stale quick runs with older ${filename}`, async t => {
    const h = fixture(t), stamp = new Date(now).toISOString();
    fs.writeFileSync(path.join(h, '.claude', filename), JSON.stringify({ provider: 'codex', t: now - 1000, until: now + 86400000, reason: 'usage_limit_no_fallback' }) + '\n');
    const probed = await laneDoctorProbe({ home: h, now, probe: async () => ({ code: 0, text: 'PONG' }) });
    assert.equal(probed.lanes.codex.lastProbeOkAt, stamp);
    for (const minutes of [31, 49]) {
      const result = laneDoctorQuick({ home: h, now: now + minutes * 60000 });
      assert.equal(result.lanes.codex.alive, true);
      assert.equal(result.lanes.codex.reason, 'probe_ok:stale');
      assert.equal(result.lanes.codex.probedAt, stamp);
      assert.equal(result.lanes.codex.lastProbeOkAt, stamp);
      assert.equal(result.lanes.codex.probeReason, 'auth_ok:probe_ok');
      assert.ok(summarize(result).includes(`codex ✅(stale ${minutes}m)`));
    }
  });
  test(`ignores until beyond seven days in ${filename}`, t => {
    const h = fixture(t), until = now + 100 * 86400000;
    fs.writeFileSync(path.join(h, '.claude', filename), JSON.stringify({ provider: 'codex', t: now - 1000, until, reason: 'usage_limit_no_fallback' }) + '\n');
    const result = laneDoctorQuick({ home: h, now });
    assert.equal(result.lanes.codex.alive, true);
    assert.deepEqual(result.ignored, [{ provider: 'codex', reason: 'until_beyond_7d', until }]);
  });
}
test('newer limits block without erasing probe history across quick runs', async t => {
  const h = fixture(t), stamp = new Date(now).toISOString();
  await laneDoctorProbe({ home: h, now, probe: async () => ({ code: 0, text: 'PONG' }) });
  fs.writeFileSync(path.join(h, '.claude/codex-limit-history.jsonl'), JSON.stringify({ t: now + 1000, until: now + 86400000, reason: 'usage_limit_no_fallback' }) + '\n');
  for (const minutes of [31, 32]) {
    const result = laneDoctorQuick({ home: h, now: now + minutes * 60000 });
    assert.equal(result.lanes.codex.alive, false);
    assert.equal(result.lanes.codex.reason, 'usage_limit_no_fallback');
    assert.equal(result.lanes.codex.lastProbeOkAt, stamp);
    assert.equal(result.lanes.codex.probedAt, stamp);
  }
});
test('migrates legacy successful probe and keeps seven-day boundary valid', t => {
  const h = fixture(t), stamp = new Date(now - 49 * 60000).toISOString();
  write(h, 'lane-health.json', { lanes: { codex: { alive: true, reason: 'auth_ok:probe_ok', probedAt: stamp } } });
  let result = laneDoctorQuick({ home: h, now });
  assert.equal(result.lanes.codex.lastProbeOkAt, stamp);
  assert.equal(result.lanes.codex.reason, 'probe_ok:stale');
  fs.writeFileSync(path.join(h, '.claude/codex-limit-history.jsonl'), JSON.stringify({ t: now, until: now + 7 * 86400000, reason: 'usage_limit' }) + '\n');
  result = laneDoctorQuick({ home: h, now });
  assert.equal(result.lanes.codex.alive, false);
  assert.deepEqual(result.ignored, []);
});

test('cached and failed probes retain the last real success time', async t => {
  const h = fixture(t), stamp = new Date(now).toISOString();
  const probe = async () => ({ code: 0, text: 'PONG' });
  await laneDoctorProbe({ home: h, now, probe });
  const cached = await laneDoctorProbe({ home: h, now: now + 60000, probe });
  assert.equal(cached.lanes.codex.lastProbeOkAt, stamp);
  assert.equal(cached.lanes.codex.probedAt, stamp);
  const failed = await laneDoctorProbe({ home: h, now: now + 31 * 60000,
    probe: async () => ({ code: 1, text: 'HTTP 429 retry in 1 hour' }) });
  assert.equal(failed.lanes.codex.lastProbeOkAt, stamp);
  assert.equal(failed.lanes.codex.probeReason, 'cooldown');
  const quick = laneDoctorQuick({ home: h, now: now + 62 * 60000 });
  assert.equal(quick.lanes.codex.alive, false);
  assert.equal(quick.lanes.codex.lastProbeOkAt, stamp);
  assert.equal(quick.lanes.codex.probedAt, failed.lanes.codex.probedAt);
  assert.equal(quick.lanes.codex.probeReason, 'cooldown');
});
test('unprobed configuration remains distinct and equal-time limits are superseded', t => {
  const h = fixture(t), stamp = new Date(now).toISOString();
  assert.equal(laneDoctorQuick({ home: h, now }).lanes.codex.reason, 'configured:unprobed');
  write(h, 'lane-health.json', { lanes: { codex: { alive: true, reason: 'auth_ok:probe_ok', probedAt: stamp, lastProbeOkAt: stamp } } });
  fs.writeFileSync(path.join(h, '.claude/codex-limit-history.jsonl'), JSON.stringify({ t: now, until: now + 86400000 }) + '\n');
  for (const minutes of [31, 32]) assert.equal(laneDoctorQuick({ home: h, now: now + minutes * 60000 }).lanes.codex.alive, true);
});

test('Gemini billing notification includes official steps, account, outcome and fallback', t => {
  const text = notificationText({provider:'gemini',reason:'dead:payment_required'},fixture(t));
  for (const expected of ['https://aistudio.google.com/billing','kim@orgiast.jp','個人 Gmail','シークレットウィンドウ','右上アバター','Available credits','Setup auto-reload','Manage auto-reload','支払い方法・補充額・最低残高しきい値','monthly auto-charge limit','保存','0 より大きく','03:00','次セッション開始','gemini ✅','キー所有アカウントが別','Gemini まだ 402']) assert.ok(text.includes(expected), expected);
  assert.match(text,/\n根拠: https:\/\/ai.google.dev\/gemini-api\/docs\/billing$/);
});
