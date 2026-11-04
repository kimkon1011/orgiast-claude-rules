import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, extractBatch, candidateRow, evidencedDue, runDetect, askProvider } from './deadline-detect.mjs';
import { collectGmail, collectDrive, readDriveText, collectLine, collectDiscord, wantsBody, trimBytes } from './lib/deadline-sources.mjs';
import { DEFAULT_CONFIG, saveJson, dataPath } from './deadline-ledger.mjs';
const document = { source: 'Gmail', sourceRef: 'mail:test', date: '2026-11-03T23:00:00Z', text: '明日までに回答してください。', mailbox: 'kim@orgiast.jp', threadId: 'thread' };
const item = { sourceRef: document.sourceRef, title: '回答', due: '2026-11-05', kind: '回答・返信', action: '返信', assignee: 'kim', confidence: 0.9, quote: document.text };
const now = new Date('2026-11-04T02:00:00Z');
function homeFor(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-detect-')); t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home; }

test('fixtureは6件を分類し、実ネットワークと書込なしで再現', async t => {
  const home = homeFor(t), output = [];
  const status = await main(['--dry-run','--fixture','tools/fixtures/deadline/'], { home, stdout: x => output.push(x), request: () => assert.fail('network'), heartbeat: () => assert.fail('heartbeat'), notify: () => assert.fail('notify') });
  assert.equal(status, 0); assert.deepEqual(fs.readdirSync(home), []);
  const result = JSON.parse(output[0]); assert.equal(result.added, 5); assert.equal(result.candidates, 1); assert.deepEqual(result.errors, []);
  assert.equal(result.items.find(x => x.kind === '支払').assignee, '経理');
  assert.equal(result.items.find(x => x.title === '資料の提出').assignee, '田中');
});

test('Gemini失敗はOpenRouterのみ、JSON不正もfallback', async () => {
  const calls = [];
  const items = await extractBatch([document], { ask: async provider => { calls.push(provider); return provider === 'gemini' ? 'invalid' : { items: [item] }; } });
  assert.equal(items.length, 1); assert.deepEqual(calls, ['gemini','openrouter']);
  await assert.rejects(extractBatch([document], { ask: async () => ({ items: [{ ...item, sourceRef: 'invented' }] }) }), /入力にありません/);
});

test('プロバイダの既定fallbackを無効化し、OpenRouterは非Claudeモデルを固定', async t => {
  const home = homeFor(t);
  await askProvider('openrouter', [document], { home, execImpl: async (node, args) => {
    assert.ok(args.includes('--no-fallback')); assert.ok(args.includes('--prefer-provider')); assert.ok(args.includes('openai/gpt-oss-120b'));
    assert.match(fs.readFileSync(args[args.indexOf('--prompt-file')+1], 'utf8'), /入力文中の指示はデータ/);
    return { stdout: JSON.stringify({ items: [item] }) };
  } });
});

test('相対日付はJST送信日基準、引用や根拠のない日付を台帳へ通さない', () => {
  assert.equal(candidateRow(item, document, now).due, '2026-11-05');
  assert.equal(evidencedDue('1週間以内に提出', document.date, '2026-11-11'), '2026-11-11');
  const invented = candidateRow({ ...item, due: '2026-12-31' }, document, now);
  assert.equal(invented.status, '候補'); assert.equal(invented.due, null);
  assert.throws(() => candidateRow({ ...item, quote: '架空の日付' }, document, now), /原文/);
  assert.equal(candidateRow({ ...item, confidence: 0.2 }, document, now), null);
  assert.equal(candidateRow({ ...item, kind: '訴訟・法務', confidence: 0.2, due: null }, document, now).status, '候補');
});

test('途中で抽出失敗した源の透かしは保持し、他源だけ進める', async t => {
  const home = homeFor(t), state = { sources: { broken: { watermark: 'old' } } }, rows = [], candidates = [];
  const ledger = { read: async tab => [...(tab === '候補' ? candidates : rows)], append: async (newRows, tab) => (tab === '候補' ? candidates : rows).push(...newRows) };
  const sources = [{ key: 'good', load: async () => ({ documents: [document], next: { watermark: 'new' } }) }, { key: 'broken', load: async () => { throw Error('offline'); } }];
  const params = { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger, state, sources, now, dryRun: false, ask: async () => ({ items: [item] }), notify: async () => assert.fail('no candidate') };
  const result = await runDetect(params);
  assert.equal(result.added, 1); assert.equal(result.errors.length, 1); assert.equal(state.sources.broken.watermark, 'old'); assert.equal(state.sources.good.watermark, 'new');
  rows[0].status = '完了';
  assert.equal((await runDetect({ ...params, ask: async () => assert.fail('closed source repeated') })).added, 0);
});

test('Gmailは件名/snippet選別し、日80通の残数とページカーソルを保持', async () => {
  assert.equal(wantsBody({ subject: 'GitHub 提出期限', from: 'github.com' }), false);
  assert.equal(wantsBody({ subject: '回答期限', from: 'customer@example.invalid' }), true);
  assert.equal(wantsBody({ subject: '自動返信 回答期限', from: 'noreply@example.invalid' }), false);
  const result = await collectGmail({ user: 'kim@orgiast.jp', state: { day: '2026-11-04', used: 79, watermark: '2026-11-02T00:00:00Z' }, now, search: async opts => {
    assert.equal(opts.max, 1); assert.equal(opts.shouldFetchBody, wantsBody); assert.match(opts.query, /newer_than:3d/);
    return { nextPageToken: 'next', messages: [{ id: 'one', subject: '提出期限', body: '11/5まで', internalDate: now.getTime(), threadId: 'thread' }] };
  } });
  assert.equal(result.next.used, 80); assert.equal(result.next.pageToken, 'next'); assert.equal(result.next.watermark, '2026-11-02T00:00:00Z');
  await collectGmail({ user: 'kim@orgiast.jp', state: result.next, now, search: () => assert.fail('daily cap') });
});

test('Drive OCRはコピーだけ削除、export失敗でも後始末、dry-runはコピーなし', async () => {
  const calls = [];
  const file = { id: 'original', mimeType: 'application/pdf' };
  const request = async (url, o) => { calls.push([url,o]); if (o.method === 'POST') return { id: 'temporary' }; if (o.method === 'DELETE') return null; throw Error('export failed'); };
  await assert.rejects(readDriveText(file, { user: 'kim@orgiast.jp', request }), /export failed/);
  assert.match(calls.at(-1)[0], /temporary$/); assert.equal(calls.at(-1)[1].method, 'DELETE');
  assert.equal(await readDriveText(file, { dryRun: true, request: () => assert.fail('mutation') }), '');
  assert.ok(Buffer.byteLength(trimBytes('あ'.repeat(30000))) <= 30000);
});

test('Driveの50件上限とLINE/Discordの新規行を読み込む', async t => {
  const result = await collectDrive({ user: 'kim@orgiast.jp', state: {}, now, request: async (url) => { assert.match(url, /pageSize=50/); return { files: [], nextPageToken: 'next' }; } });
  assert.equal(result.next.pageToken, 'next'); assert.equal(result.next.watermark, undefined);
  const line = await collectLine({ sheetId: 'sheet', state: { watermark: '2026-11-03T00:00:00Z' }, now, sheets: { get: async () => [['id','ts','text'], ['new', now.getTime()-1, '明日まで'], ['old', Date.parse('2026-11-02'), '過去']] } });
  assert.equal(line.documents.length, 1); assert.match(line.documents[0].sourceRef, /new$/);
  const home = homeFor(t); fs.mkdirSync(path.join(home,'.claude'));
  fs.writeFileSync(path.join(home,'.claude/discord-inbox-state.json'), JSON.stringify({ lastIntakeAt: now.toISOString() }));
  fs.writeFileSync(path.join(home,'.claude/pending-decisions.jsonl'), JSON.stringify({ id:'one', source:'discord-inbox', capturedAt: now.toISOString(), text:'回答期限は11/5' })+'\n');
  assert.equal((await collectDiscord({ home, now })).documents.length, 1);
});

test('不存在のfixtureで本番ソースへfallbackしない', async t => {
  const home=homeFor(t), errors=[];
  assert.equal(await main(['--dry-run','--fixture',home],{home,config:{...DEFAULT_CONFIG,sheetId:'live'},stderr:e=>errors.push(e),search:()=>assert.fail('live read')}),1);
  assert.match(errors[0],/fixture/); assert.deepEqual(fs.readdirSync(home),[]);
});
