import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, listItems, main, answerItem, markSeen, updateInboxItem, selectContext } from './kim-inbox.mjs';
import { evaluateKimInboxRelay, commitKimInboxDelivery } from './kim-inbox-relay.mjs';
import { inboxSummary, formatInboxBrief, recordInjection, recordPromptAnswers, recordNaturalLanguageAnswers, relayDue, interactiveInboxSession, groupInboxItems } from './lib/kim-inbox-relay-state.mjs';
import { run } from './stop-gate-runner.mjs';
const now = Date.parse('2026-11-12T10:00:00Z');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-relay-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  const input = { session_id: 'human-session', cwd: home };
  const f = { home, input, inject: items => recordInjection(home, input.session_id, items, { now }),
    judge: (text = '', extra = {}) => evaluateKimInboxRelay(input, { home, now, env: {}, text, ...extra }),
    section: items => '【受信箱】
' + items.map((i,n) => formatInboxBrief(i, n + 1)).join('
') };
  // Fixtures are retained under /tmp; production inboxes are never modified.
  return f;
}
test('context injection is not delivery; final ID and structured lines are required', async t => {
  const f = fixture(t), item = await addItem(f.home, { kind: 'ask', text: '鍵付き化が完了。nacci0713 の扱いと PR #7 は承認待ち' });
  const output = [];
  await main(['--context'], { home: f.home, stdout: s => output.push(s), readStdin: async () => JSON.stringify({ ...f.input, hook_event_name: 'UserPromptSubmit' }) });
  assert.equal(listItems(f.home)[0].shownCount, 1);
  assert.equal(listItems(f.home)[0].deliveredToKim, undefined);
  assert.equal(f.judge('別作業は完了しました', { raw: f.section([item]) }).decision, 'block');
  assert.equal(f.judge(`【受信箱】
${item.id}`).decision, 'block');
  assert.equal(f.judge(`${item.id} ${inboxSummary(item)}`).decision, 'block');
  assert.equal(f.judge(`【受信箱】
1. ${item.id} ${inboxSummary(item)}`).decision, 'block');
  assert.equal(f.judge(f.section([item]).replaceAll(item.id, '')).decision, 'block');
  assert.equal(f.judge('```
' + f.section([item]) + '
```').decision, 'block');
  assert.equal(f.judge(f.section([item]).split('
').map(l => '> ' + l).join('
')).decision, 'block');
  assert.equal(f.judge(f.section([item])).decision, 'pass');
});

test('each item needs its own explanation; indented and bulleted numbering delimit items', async t => {
  const f = fixture(t), a = await addItem(f.home, { kind: 'ask', text: '承認待ち: 資料の公開' });
  const b = await addItem(f.home, { kind: 'ask', text: '承認待ち: 日程の変更' });
  f.inject([a, b]);
  for (const prefix of ['2.', '  2.', '- 2.']) {
    assert.equal(f.judge(`【受信箱】
1. ${a.id}
${prefix} ${b.id}
   返事: 可か不可`).decision, 'block');
  }
  assert.equal(f.judge(`【受信箱】
1. ${a.id}-extra
判断: 確認
2. ${b.id}
返事: 確認`).decision, 'block');
  const result = f.judge(`【受信箱】
1. 公開の件（${a.id}）
   判断: 資料を公開するか
2. 日程の件（${b.id}）
   返事: 可または不要`);
  assert.equal(result.decision, 'pass');
  assert.equal(result.receipts[0].summary, formatInboxBrief(a, 1, { home: f.home }).split('
')[0]);
});

test('decorated inbox headings, trailing labels and paraphrases pass; missing IDs and later sections do not', async t => {
  const f = fixture(t);
  const a = await addItem(f.home, { kind: 'ask', text: '原文の長い依頼です' });
  const b = await addItem(f.home, { kind: 'ask', text: '別の長い依頼です' });
  f.inject([a, b]);
  for (const heading of ['【受信箱】確認事項', '### 【受信箱】', '**【受信箱】** 要点', '  ### **【受信箱】**（2件）']) {
    assert.equal(f.judge(`${heading}
1. ${a.id}
判断: 公開するか
2. ${b.id}
返事: 日程を変えるか`).decision, 'pass');
    assert.equal(f.judge(`${heading}
1. ${a.id} 言い換え
判断: 公開可否
2. ${b.id} 短く要約
返事: 変更可否`).decision, 'pass');
    assert.equal(f.judge(`${heading}
1. ${a.id}
判断: 公開可否
### 別件
2. ${b.id}
返事: 変更可否`).decision, 'block');
    assert.equal(f.judge(`${heading}
${a.id}`).decision, 'block');
  }
});
test('receipts suppress same-session asks until next JST day, high info until refreshed, other sessions still see asks', async t => {
  const f = fixture(t);
  const ask = await addItem(f.home, { kind: 'ask', text: '承認をお願いします' });
  const info = await addItem(f.home, { kind: 'info', text: '進捗: PR のテスト成功', priority: 'high', dedupeKey: 'progress' });
  f.inject([ask,info]);
  const result = f.judge(f.section([ask,info]));
  commitKimInboxDelivery(f.home, f.input.session_id, result.receipts, now);
  const saved = listItems(f.home), a = saved.find(i => i.id === ask.id), i = saved.find(i => i.id === info.id);
  assert.equal(a.deliveredToKim.count, 1); assert.equal(a.shownCount, 0);
  assert.equal(f.judge('別の作業の結果').decision, 'pass');
  assert.equal(relayDue(a, f.input.session_id, now + 3600000), false);
  assert.equal(relayDue(a, f.input.session_id, now + 86400000), true);
  assert.equal(relayDue(a, 'another-session', now), true);
  assert.equal(relayDue(i, 'another-session', now + 86400000), false);
  assert.equal(relayDue({ ...i, lastAt: new Date(now + 1).toISOString() }, 'another-session', now), false);
  assert.equal(relayDue({ ...i, text: '進捗: PR をマージ済み' }, 'another-session', now), true);
  assert.equal(selectContext(saved, { sessionId: f.input.session_id, now, home: f.home }), '');
});
test('answered, dropped, unseen-by-context and changed records are not blocked using old context', async t => {
  const f = fixture(t), a = await addItem(f.home, { kind: 'ask', text: '依頼' });
  assert.equal(f.judge().decision, 'pass'); f.inject([a]);
  answerItem(f.home, a.id, '可'); assert.equal(f.judge().decision, 'pass');
  updateInboxItem(f.home, a.id, i => { i.status = 'open'; i.text = '新しい依頼'; });
  assert.equal(f.judge().decision, 'pass');
});
test('high progress is injected with deadlines and long asks even when shownCount is already high', async t => {
  const f = fixture(t);
  const info = await addItem(f.home, { text: '進んでいること: LinuxとWindowsの検証が完了' });
  updateInboxItem(f.home, info.id, i => { i.shownCount = 900; });
  for (let n=0;n<8;n++) await addItem(f.home, { kind: 'ask', text: '判断 '+ n + '詳'.repeat(800) });
  for (let n=0;n<5;n++) await addItem(f.home, { kind: 'deadline', key: `D-${n}`, text: `期限 ${n}`, remainingDays: 1 });
  const output = [];
  await main(['--context'], { home: f.home, stdout: s => output.push(s), readStdin: async () => JSON.stringify({ ...f.input, hook_event_name: 'UserPromptSubmit' }) });
  assert.match(output.join(''), new RegExp(info.id));
  assert.match(f.judge().reason, new RegExp(info.id));
});
test('headless flags, SDK metadata, subagents and non-kim seats never force relay or record answers', async t => {
  const f = fixture(t), a = await addItem(f.home, { kind: 'ask', text: '依頼' }); f.inject([a]);
  for (const env of [{ CLAUDE_HEADLESS: '1' }, { ORGIAST_HEADLESS_JOB: 'cron' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }]) assert.equal(f.judge('', { env }).decision, 'pass');
  assert.equal(f.judge('', { raw: JSON.stringify({ entrypoint: 'sdk-cli' }) }).decision, 'pass');
  for (const input of [{ agent_id: 'worker' }, { entrypoint: 'sdk-ide' }, { transcript_path: '/projects/a/subagents/b.jsonl' }]) assert.equal(interactiveInboxSession(input, { home: f.home, env: {} }), false);
  fs.writeFileSync(path.join(f.home, '.claude.json'), '{}');
  assert.equal(f.judge().decision, 'pass');
});
test('1 可 records the shown ask via answerItem; quoted, ambiguous, stale and other-session replies do not', async t => {
  const f = fixture(t), a = await addItem(f.home, { kind: 'ask', text: 'PR のマージを承認してください' }); f.inject([a]);
  commitKimInboxDelivery(f.home, f.input.session_id, f.judge(f.section([a])).receipts, now);
  const answer = (prompt, session = f.input.session_id) => recordPromptAnswers(f.home, session, prompt, { listItems, answerItem });
  for (const p of ['例: 1 可', '1 可
作業を調べて', '> 1 可', '1 保留']) assert.equal(answer(p).length, 0);
  assert.equal(answer('1 可', 'other').length, 0);
  assert.equal(answer('1 可').length, 1);
  assert.equal(listItems(f.home)[0].answer, '可');
  assert.equal(listItems(f.home)[0].answerSession, f.input.session_id);
  const multi = await addItem(f.home, { kind: 'ask', text: '承認待ち2件
1. 共有
2. 配布' }); f.inject([multi]);
  commitKimInboxDelivery(f.home, f.input.session_id, f.judge(f.section([multi])).receipts, now);
  assert.equal(answer('1 可').length, 0);
});
test('runner relay precedes retry/close bypasses, and another gate rejecting a draft prevents receipt', async t => {
  const f = fixture(t), a = await addItem(f.home, { kind: 'ask', text: '登録の承認をお願いします' }); f.inject([a]);
  const old = process.env.ORGIAST_HOME; process.env.ORGIAST_HOME = f.home;
  t.after(() => { if (old === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = old; });
  const ctx = { raw: '', humanText: '確認して', assistantText: '' };
  for (let n=0;n<2;n++) assert.equal((await run({ ...f.input, stop_hook_active: true, last_assistant_message: '完了' }, ctx)).record.blockedBy[0], 'kim-inbox-relay');
  // 2026-11-15: 同じターン3回目以降は警告のみ。配達記録は付けず、次のターンで再度届ける。
  const capped = await run({ ...f.input, stop_hook_active: true, last_assistant_message: '完了' }, ctx);
  assert.notEqual(capped.decision, 'block');
  assert.match(capped.systemMessage, /kim-inbox-relay/);
  assert.equal(listItems(f.home)[0].deliveredToKim, undefined);
  fs.rmSync(path.join(f.home, '.claude', 'stop-gate-repeat-state.json'), { force: true });
  const result = await run({ ...f.input, last_assistant_message: f.section([a]) + '
https://discord.com/oauth2/authorize?client_id=1511684767546871818&permissions=0' }, ctx);
  assert.equal(result.decision, 'block');
  assert.equal(listItems(f.home)[0].deliveredToKim, undefined);
  const successText = f.section([a]) + '
【最終まとめ】
①報告: 受信箱を提示しました
②kim の確認事項: 受信箱の判断
③kim がやること: 返事の例から回答
恒久策: 一回限り: このfixture固有の配達確認
次に kim がすること: 受信箱へ回答
この後の自動進行: なし
このセッション: /session-close は不要なので、このセッションを閉じてよい';
  const success = await run({ ...f.input, last_assistant_message: successText }, ctx);
  assert.notEqual(success.decision, 'block', JSON.stringify(success));
  assert.equal(listItems(f.home)[0].deliveredToKim.count, 1);
});

test('manual --seen during a turn cannot bypass final-message verification', async t => {
  const f = fixture(t), info = await addItem(f.home, { text: '完了: 検証成功', priority: 'high' });
  f.inject([info]); markSeen(f.home, info.id);
  assert.equal(f.judge('完了しました').decision, 'block');
  commitKimInboxDelivery(f.home, f.input.session_id, f.judge(f.section([info])).receipts, now);
  assert.equal(listItems(f.home)[0].deliveredToKim.count, 1);
});

test('two inbox blocks exhaust the shared turn budget, but permission blocks survive', async t => {
  const f = fixture(t), item = await addItem(f.home, { kind: 'ask', text: '確認事項' });
  f.inject([item]);
  const old = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = f.home;
  t.after(() => { if (old === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = old; });
  const ctx = { raw: '', humanText: '', assistantText: '' };
  const options = { mode: 'off', policyOptions: { home: f.home, hostname: 'kim-PC', notify: async () => ({ delivered: 'test' }) } };
  for (let n = 0; n < 2; n++) assert.equal((await run({ ...f.input, assistant_text: '完了' }, ctx, options)).decision, 'block');
  const changed = await run({ ...f.input, assistant_text: `${f.section([item])}
GitHub の画面で Merge をクリックしてください。` }, ctx, options);
  assert.notEqual(changed.decision, 'block');
  assert.match(changed.systemMessage, /同一ターン上限/);
  assert.equal(listItems(f.home)[0].deliveredToKim, undefined);
  for (let n = 0; n < 4; n++) {
    const safety = await run({ ...f.input, assistant_text: 'https://discord.com/oauth2/authorize?client_id=1511684767546871818&permissions=0' }, ctx, options);
    assert.equal(safety.decision, 'block');
    assert.match(safety.reason, /権限/);
  }
});

test('passkey ask relays the complete signed URL rather than a truncated token', async t => {
  const f = fixture(t), url = 'https://keyserve.test/api/knowledge?register=' + 'a'.repeat(500);
  const item = await addItem(f.home, { kind: 'ask', priority: 'high', source: 'knowledge-lock-passkey-link', text: `パスキー登録をお願いします。
登録リンク: ${url}` });
  const context = selectContext([item], { sessionId: f.input.session_id, now, home: f.home });
  assert.ok(context.includes(url)); f.inject([item]);
  assert.ok(f.judge().reason.includes(url));
});

test('hundreds of reserved asks rotate in bounded batches without starving progress', async t => {
  const f = fixture(t), base = await addItem(f.home, { kind: 'ask', text: '承認待ち', priority: 'high' });
  const items = Array.from({length:150}, (_,n)=>({...base, id:`ki-20261112000000-${n.toString(16).padStart(4,'0')}`, shownSessions:[], shownCount:0}));
  const info = await addItem(f.home, { text: '完了: テスト成功', priority: 'high' }); items.push(info);
  const first = selectContext(items, {sessionId:f.input.session_id, now, home:f.home});
  assert.ok(first.includes(info.id));
  assert.ok(items.filter(i=>i.shownCount>0).length <= 11);
  const initial = new Set(items.filter(i=>i.shownCount>0).map(i=>i.id));
  selectContext(items,{sessionId:f.input.session_id,now,home:f.home});
  assert.ok(items.some(i=>i.shownCount>0 && !initial.has(i.id)));
});

test('duplicate same workId+decide: only representative needs written; both are receipts', async t => {
  const f = fixture(t);
  const baseText = '【DELL・seisaku-team@orgiast.jp の Claude Code】プロジェクト: test ／ セッションの目的: 三共精機にメール送信 ／ 作業ID: c8d99e2b
自動進行が判断待ちです: メールの送付可否
あなたの返事待ち: 送ってよいですか';
  const a = await addItem(f.home, { kind: 'ask', text: baseText });
  const b = await addItem(f.home, { kind: 'ask', text: baseText });
  f.inject([a, b]);

  // Blocked if neither is shown
  const blocked = f.judge('別の作業をしました');
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /同じ件/);

  // Both are receipted when the deterministically selected representative is shown.
  const representative = groupInboxItems([a, b])[0].representative;
  const section = '【受信箱】
' + formatInboxBrief(representative, 1);
  const result = f.judge(section);
  assert.equal(result.decision, 'pass', `${result.code}: ${result.reason?.slice(0, 100)}`);
  assert.equal(result.receipts.length, 2);
  assert.ok(result.receipts.some(r => r.id === a.id));
  assert.ok(result.receipts.some(r => r.id === b.id));
});

test('duplicate different workId: each must appear individually', async t => {
  const f = fixture(t);
  const a = await addItem(f.home, { kind: 'ask', text: '【DELL・seisaku-team@orgiast.jp の Claude Code】プロジェクト: test ／ 作業ID: c8d99e2b
自動進行が判断待ちです: メールの送付可否
あなたの返事待ち: 送ってよいですか' });
  const b = await addItem(f.home, { kind: 'ask', text: '【DELL・seisaku-team@orgiast.jp の Claude Code】プロジェクト: test ／ 作業ID: 7f14e87b
自動進行が判断待ちです: メールの送付可否
あなたの返事待ち: 送ってよいですか' });
  f.inject([a, b]);

  // Only one in section → blocked
  const result = f.judge('【受信箱】
' + formatInboxBrief(a, 1));
  assert.equal(result.decision, 'block');
});

test('inboxSummary does not split emoji surrogate pairs at its caps', () => {
  const loneSurrogate = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;
  const heading = inboxSummary({ kind: 'ask', text: `${'あ'.repeat(139)}🚀 承認待ち: テストが成功しました。🔑 鍵付きです` });
  const action = inboxSummary({ kind: 'ask', text: `件名
${'い'.repeat(89)}🚀 承認待ち` });
  assert.doesNotMatch(heading, loneSurrogate);
  assert.doesNotMatch(action, loneSurrogate);
});

// --- Natural language reply auto-recording tests ---
test('NL: single affirmative with single pending ask records as '可'', t => {
  const f = fixture(t);
  const item = { id: 'ki-20261112000000-0001', kind: 'ask', text: '承認待ち: 資料の公開', createdAt: '2026-11-12T00:00:00.000Z', lastAt: '2026-11-12T00:00:00.000Z', status: 'open', shownSessions: [], shownCount: 0 };
  const dir = path.join(f.home, '.claude/kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, item.id + '.json'), JSON.stringify(item));
  const revision = require('crypto').createHash('sha256').update(JSON.stringify(['ask', item.text, undefined, undefined])).digest('hex');
  const stateDir = path.join(f.home, '.claude/kim-inbox-relay');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, require('crypto').createHash('sha256').update(f.input.session_id).digest('hex') + '.json'),
    JSON.stringify({ sessionId: f.input.session_id, lastDelivered: [{ id: 'ki-20261112000000-0001', number: 1, revision }] }) + '
');
  const result = recordNaturalLanguageAnswers(f.home, f.input.session_id, '良いですよ', { listItems, answerItem });
  assert.equal(result.answers.length, 1);
  assert.equal(result.hints.length, 0);
  const saved = listItems(f.home).find(i => i.id === 'ki-20261112000000-0001');
  assert.equal(saved.answer, '可');
});

test('NL: numbered natural (1. 良い 2. OK) records both', t => {
  const f = fixture(t);
  const a = { id: 'ki-20261112000000-0001', kind: 'ask', text: '公開承認', createdAt: '2026-11-12T00:00:00.000Z', lastAt: '2026-11-12T00:00:00.000Z', status: 'open', shownSessions: [], shownCount: 0 };
  const b = { id: 'ki-20261112000000-0002', kind: 'ask', text: '変更承認', createdAt: '2026-11-12T00:00:00.000Z', lastAt: '2026-11-12T00:00:00.000Z', status: 'open', shownSessions: [], shownCount: 0 };
  const dir = path.join(f.home, '.claude/kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, a.id + '.json'), JSON.stringify(a));
  fs.writeFileSync(path.join(dir, b.id + '.json'), JSON.stringify(b));
  const revA = require('crypto').createHash('sha256').update(JSON.stringify(['ask', a.text, undefined, undefined])).digest('hex');
  const revB = require('crypto').createHash('sha256').update(JSON.stringify(['ask', b.text, undefined, undefined])).digest('hex');
  const stateDir = path.join(f.home, '.claude/kim-inbox-relay');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, require('crypto').createHash('sha256').update(f.input.session_id).digest('hex') + '.json'),
    JSON.stringify({ sessionId: f.input.session_id, lastDelivered: [{ id: a.id, number: 1, revision: revA }, { id: b.id, number: 2, revision: revB }] }) + '
');
  const result = recordNaturalLanguageAnswers(f.home, f.input.session_id, '1. 良い
2. OK', { listItems, answerItem });
  assert.equal(result.answers.length, 2);
  const savedA = listItems(f.home).find(i => i.id === a.id);
  const savedB = listItems(f.home).find(i => i.id === b.id);
  assert.equal(savedA.answer, '可');
  assert.equal(savedB.answer, '可');
});

test('NL: multiple pending with vague reply returns hints not answers', t => {
  const f = fixture(t);
  const items = [1,2,3].map(i => ({ id: 'ki-20261112000000-000' + i, kind: 'ask', text: '判断' + i, createdAt: '2026-11-12T00:00:00.000Z', lastAt: '2026-11-12T00:00:00.000Z', status: 'open', shownSessions: [], shownCount: 0 }));
  const dir = path.join(f.home, '.claude/kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  for (const item of items) fs.writeFileSync(path.join(dir, item.id + '.json'), JSON.stringify(item));
  const stateDir = path.join(f.home, '.claude/kim-inbox-relay');
  fs.mkdirSync(stateDir, { recursive: true });
  const delivered = items.map((item, n) => ({ id: item.id, number: n + 1,
    revision: require('crypto').createHash('sha256').update(JSON.stringify(['ask', item.text, undefined, undefined])).digest('hex') }));
  fs.writeFileSync(path.join(stateDir, require('crypto').createHash('sha256').update(f.input.session_id).digest('hex') + '.json'),
    JSON.stringify({ sessionId: f.input.session_id, lastDelivered: delivered }) + '
');
  const result = recordNaturalLanguageAnswers(f.home, f.input.session_id, 'OK', { listItems, answerItem });
  assert.equal(result.answers.length, 0);
  assert.ok(result.hints.length > 0);
});

test('NL: no delivery state returns empty', t => {
  const f = fixture(t);
  const result = recordNaturalLanguageAnswers(f.home, f.input.session_id, '良いです', { listItems, answerItem });
  assert.equal(result.answers.length, 0);
  assert.equal(result.hints.length, 0);
});

test('NL: negative keyword records as 否認', t => {
  const f = fixture(t);
  const item = { id: 'ki-20261112000000-0001', kind: 'ask', text: '不要な作業', createdAt: '2026-11-12T00:00:00.000Z', lastAt: '2026-11-12T00:00:00.000Z', status: 'open', shownSessions: [], shownCount: 0 };
  const dir = path.join(f.home, '.claude/kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, item.id + '.json'), JSON.stringify(item));
  const revision = require('crypto').createHash('sha256').update(JSON.stringify(['ask', item.text, undefined, undefined])).digest('hex');
  const stateDir = path.join(f.home, '.claude/kim-inbox-relay');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, require('crypto').createHash('sha256').update(f.input.session_id).digest('hex') + '.json'),
    JSON.stringify({ sessionId: f.input.session_id, lastDelivered: [{ id: item.id, number: 1, revision }] }) + '
');
  const result = recordNaturalLanguageAnswers(f.home, f.input.session_id, '不要', { listItems, answerItem });
  assert.equal(result.answers.length, 1);
  const saved = listItems(f.home).find(i => i.id === item.id);
  assert.equal(saved.answer, '否認');
});
