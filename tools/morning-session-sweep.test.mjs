import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { addItem, listItems, ingestFleetMail, markSeen } from './kim-inbox.mjs';
import { collectSessions, runSweep, waitingReason, formatDigest } from './morning-session-sweep.mjs';
function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'morning-sweep-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const dir=path.join(home,'.claude','projects','p'); fs.mkdirSync(dir,{recursive:true});
  function put(id,title,answer,age=0,sub='') {
    const file=path.join(dir,sub,id+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
    const rows=[{type:'custom-title',customTitle:title},{type:'user',message:{role:'user',content:'最初の依頼'}},{type:'user',message:{role:'user',content:'最後の依頼'}},{type:'assistant',message:{role:'assistant',content:answer}}];
    fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\ncorrupt line\n');
    const time=new Date(Date.now()-age*86400000);fs.utimesSync(file,time,time);
    return file;
  }
  return {home,put};
}
test('recent unclosed sessions only, latest prompt/title/deadline and three wait reasons',async t=>{
  const f=fixture(t);f.put('kim','案件A【11/06/09:30まで】','kim 待ち');f.put('external','案件B','先方の返信待ち');f.put('working','案件C','作業中');f.put('old','古い','作業中',8);f.put('closed','終了','作業中');f.put('titleclosed','終了【閉じて可】','完了');f.put('agent-1','子','作業中',0,'subagents');
  fs.writeFileSync(path.join(f.home,'.claude','closed-sessions.json'),JSON.stringify({ids:['closed']}));
  const sessions=await collectSessions({home:f.home}); assert.equal(sessions.length,3);
  const a=sessions.find(s=>s.sessionId==='kim');assert.equal(a.deadline,'11/06/09:30');assert.equal(a.request,'最後の依頼');assert.equal(a.reason,'kim 待ち');
  assert.equal(sessions.find(s=>s.sessionId==='external').reason,'外部待ち');assert.equal(sessions.find(s=>s.sessionId==='working').reason,'作業途中');
});
test('existing inbox/fleet route, PC label and daily dedupe; dry run does not publish',async t=>{
  const f=fixture(t);f.put('a','案件A','作業中');const calls=[];const post=async(...args)=>{calls.push(args);return {};};
  await runSweep({home:f.home,label:'営業PC-2',post,dryRun:true});assert.equal(calls.length,0);
  const r=await runSweep({home:f.home,label:'営業PC-2',post});assert.equal(calls.length,1);assert.match(calls[0][1].dedupeKey,/morning-session-sweep:営業PC-2:/);assert.match(r.text,/営業PC-2.*kim 待ち 0件／作業途中 1件／外部待ち 0件（計 1件）/);assert.equal(calls[0][1].source,'morning-session-sweep');
  await assert.rejects(runSweep({home:f.home,label:'PC-2',post:async()=>({forwardError:'offline'})}),/未完了/);
});
test('latest human request overrides old waiting text',()=>assert.equal(waitingReason('案件','kim 待ち','user'),'作業途中'));

function append(file, text, extra = {}) {
  fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra }) + '\n');
}
test('realistic automated sessions and machine prompts produce one ordered digest', async t => {
  const f = fixture(t);
  for (const [id, prompt] of Object.entries({ headless: '[headless:claude-ai-run] 定期処理', autopilot: 'autopilot tick: 次を処理', fleet: 'これは 営業-PC PC の Claude Code から kim-PC への依頼です', quota: 'quota-sweep 定期確認' })) {
    append(f.put(id, id, '作業中'), prompt);
  }
  append(f.put('auto', '自動確認', '作業中'), '自動確認', { cwd: path.join(f.home, '.claude', 'auto-session') });
  f.put('work', '作業案件', '作業中'); f.put('external', '外部案件', '返信待ち');
  f.put('later', '午後案件【11/06/15:00まで】', 'kim 待ち');
  const early = f.put('early', '午前案件【11/06/09:00まで】', 'kim 待ち');
  for (const text of ['Stop hook feedback: 再実行せよ', 'Base directory for this skill: C:/skills/test\n# 作業手順', '<command-message>foo</command-message>']) append(early, text);
  const calls = [];
  const r = await runSweep({ home: f.home, label: 'kim-PC', post: async (_, item) => { calls.push(item); return {}; } });
  assert.equal(calls.length, 1);
  assert.deepEqual(r.sessions.map(s => s.sessionId), ['early', 'later', 'external', 'work']);
  assert.equal(r.sessions[0].name, '午前案件'); assert.equal(r.sessions[0].request, '最後の依頼');
  assert.match(r.text, /^早朝セッション巡回（kim-PC）: kim 待ち 2件／作業途中 1件／外部待ち 1件（計 4件）/);
  assert.match(r.text, /自動実行の未クローズ 5件（kim の対応不要）$/);
  assert.doesNotMatch(r.text, /Stop hook|Base directory|command-message|【/);
  assert.match(calls[0].dedupeKey, /^morning-session-sweep:kim-PC:\d{4}-\d{2}-\d{2}$/);
});
test('large sweep preserves priority, full counts and omission footer without splitting', async t => {
  const f = fixture(t);
  for (let i = 0; i < 70; i++) f.put('s' + i, '長い案件名'.repeat(20) + i, i === 69 ? 'kim 待ち' : '作業中');
  const calls = [];
  const r = await runSweep({ home: f.home, label: 'kim-PC', post: async (_, item) => { calls.push(item); return {}; } });
  assert.equal(calls.length, 1); assert.ok(r.text.length <= 4000);
  assert.match(r.text, /kim 待ち 1件／作業途中 69件／外部待ち 0件（計 70件）/);
  assert.match(r.text.split('\n')[1], /｜kim 待ち｜/);
  const shown = r.text.split('\n').filter(s => s.startsWith('・')).length;
  assert.match(r.text, new RegExp('ほか ' + (70 - shown) + '件'));
  assert.match(r.text, /自動実行の未クローズ 0件（kim の対応不要）$/);
});
test('same-day rerun replaces persisted inbox text, next day creates a new item', async t => {
  const f = fixture(t); f.put('a', '案件', '作業中');
  // Existing forwarding evidence prevents real network traffic in this persistence test.
  const post = (home, item) => addItem(home, { ...item, forwardMailId: 'fixture' }, { drain: false });
  const now = Date.now();
  await runSweep({ home: f.home, label: 'kim-PC', now, post });
  const first = listItems(f.home)[0]; markSeen(f.home, first.id);
  f.put('b', '追加案件', 'kim 待ち');
  await runSweep({ home: f.home, label: 'kim-PC', now, post });
  const items = listItems(f.home); assert.equal(items.length, 1); assert.equal(items[0].id, first.id);
  assert.match(items[0].text, /計 2件/); assert.equal(items[0].status, 'open');
  await runSweep({ home: f.home, label: 'kim-PC', now: now + 86400000, post });
  assert.equal(listItems(f.home).length, 2);
});
test('human excerpt is limited to 60 Unicode characters', async t => {
  const f = fixture(t); append(f.put('a', '案件', '作業中'), '確認😀'.repeat(30));
  const [s] = await collectSessions({ home: f.home }); assert.equal(Array.from(s.request).length, 60);
});
test('empty sweep remains one explicit zero-count report', () => {
  assert.match(formatDigest([], 'kim-PC'), /kim 待ち 0件／作業途中 0件／外部待ち 0件（計 0件）/);
});
test('fleet forwarding preserves daily key and refreshes the receiving inbox', async t => {
  const sender = fixture(t), receiver = fixture(t);
  for (const [f, label] of [[sender, '営業PC-2'], [receiver, 'kim-PC']]) {
    fs.writeFileSync(path.join(f.home, '.claude/cost-reporter.env'), `REPORTER_LABEL=${label}`);
    fs.writeFileSync(path.join(f.home, '.claude/fleet-pc-map.json'), JSON.stringify({ [label]: { account: label === 'kim-PC' ? 'kim@orgiast.jp' : 'test@example.test' } }));
  }
  const inbox = path.join(receiver.home, '.claude/fleet-inbox'); fs.mkdirSync(inbox);
  let sent = 0;
  const execImpl = async (_exe, args) => {
    const id = `mail-sweep-${++sent}`;
    const why = args[args.indexOf('--why') + 1];
    assert.match(why, /\[報告・返信不要\]/);
    fs.writeFileSync(path.join(inbox, id + '.json'), JSON.stringify({ id, from: '営業PC-2', kind: 'note', why,
      body: fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'), status: 'delivered', createdAt: new Date().toISOString() }));
    return { stdout: id };
  };
  const post = (home, item) => addItem(home, { ...item, execImpl }, { drain: false });
  sender.put('a', '案件', '作業中');
  await runSweep({ home: sender.home, label: '営業PC-2', post }); await ingestFleetMail(receiver.home);
  sender.put('b', '追加案件', 'kim 待ち');
  await runSweep({ home: sender.home, label: '営業PC-2', post }); await ingestFleetMail(receiver.home);
  assert.equal(sent, 2); assert.equal(listItems(sender.home).length, 1);
  const items = listItems(receiver.home); assert.equal(items.length, 1);
  assert.match(items[0].text, /計 2件/); assert.equal(items[0].source, 'morning-session-sweep');
});

test('closed ledger と古い閉じて可タイトルより最新待機フッターを優先する', async t => {
  const f = fixture(t);
  const footer = '次に kim がすること: なし\nこの後の自動進行: 毎時確認\nこのセッション: まだ閉じない（作業中・2026-11-10 18:00 まで待つ）';
  f.put('reopened', '019｜【閉じて可】案件', footer);
  f.put('closed', '終了', '完了');
  fs.writeFileSync(path.join(f.home, '.claude', 'closed-sessions.json'), JSON.stringify({ ids: ['reopened', 'closed'] }));
  const sessions = await collectSessions({ home: f.home });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'reopened');
  assert.equal(sessions[0].deadline, '11/10/18:00');
});
