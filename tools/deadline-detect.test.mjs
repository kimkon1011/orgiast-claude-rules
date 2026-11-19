import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, extractBatch, candidateRow, evidencedDue, runDetect, askProvider, parseExtraction } from './deadline-detect.mjs';
import { seatCheck } from './lib/deadline-seat.mjs';
import { collectGmail, collectDrive, readDriveText, collectLine, collectDiscord, wantsBody, trimBytes, sourceLoaders } from './lib/deadline-sources.mjs';
import { DEFAULT_CONFIG, saveJson, dataPath } from './deadline-ledger.mjs';
import { createSheetsClient } from './lib/sheets-dwd.mjs';
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
  const { items, skipped } = await extractBatch([document], { ask: async provider => { calls.push(provider); return provider === 'gemini' ? 'invalid' : { items: [item] }; } });
  assert.equal(items.length, 1); assert.deepEqual(calls, ['gemini','openrouter']);
  // invented sourceRef is skipped, not thrown
  const result2 = await extractBatch([document], { ask: async () => ({ items: [{ ...item, sourceRef: 'invented' }] }) });
  assert.equal(result2.items.length, 0);
  assert.equal(result2.skipped.length, 1);
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
  assert.equal(candidateRow({ ...item, quote: '架空の日付' }, document, now).row, null);
  assert.equal(candidateRow({ ...item, confidence: 0.2 }, document, now).row, null);
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

test('応答しないfetchはAbortSignalでrejectされハングしない', async t => {
  // AbortSignal.timeout() does not keep Node's event loop alive. Keep this
  // isolated test alive until the abort fires, as the real scheduled process
  // has other active handles while a request is in flight.
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const started = Date.now();
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const sheets = createSheetsClient({ fetchImpl, getToken: async () => 'token', timeoutMs: 25 });
  await assert.rejects(sheets.get('sheet', 'A1'), /fetch failed.*aborted|fetch failed.*timeout/i);
  assert.ok(Date.now() - started < 1000);
});

test('Gmail quota 403は2回再試行後にsourceをスキップして続行', async t => {
  const home = homeFor(t), state = {}, delays = [], stages = [];
  const quota = Object.assign(new Error('Gmail API 403: rateLimitExceeded Quota exceeded'), { status: 403 });
  let attempts = 0;
  const sources = [
    { key: 'gmail', load: async () => { attempts++; throw quota; } },
    { key: 'discord', load: async () => ({ documents: [], next: { watermark: 'done' } }) },
  ];
  const ledger = { read: async () => [], append: async () => assert.fail('no rows') };
  const result = await runDetect({ home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger, state, sources, now, dryRun: false, ask: async () => assert.fail('no LLM'), notify: async () => {}, sleepImpl: async ms => delays.push(ms), stage: value => stages.push(value) });
  assert.equal(attempts, 3); assert.deepEqual(delays, [500, 1000]);
  assert.equal(result.errors.length, 0); assert.match(result.skipped[0].reason, /quota retry exhausted/);
  assert.deepEqual(state.sources.discord, { watermark: 'done' });
});

test('Gmailは本文取得対象だけを上限に数えページカーソルを保持', async () => {
  assert.equal(wantsBody({ subject: 'GitHub 提出期限', from: 'github.com' }), false);
  assert.equal(wantsBody({ subject: '回答期限', from: 'customer@example.invalid' }), true);
  assert.equal(wantsBody({ subject: '自動返信 回答期限', from: 'noreply@example.invalid' }), false);
  const result = await collectGmail({ user: 'kim@orgiast.jp', limit: 1, state: { day: '2026-11-04', used: 0, watermark: '2026-11-03T12:00:00Z' }, now, search: async opts => {
    assert.equal(opts.max, 100); assert.equal(opts.shouldFetchBody, wantsBody); assert.doesNotMatch(opts.query, /newer_than/);
    return { nextPageToken: 'next', messages: [{ id: 'meta', subject: 'お知らせ' }, { id: 'one', subject: '提出期限', body: '11/5まで', internalDate: now.getTime(), threadId: 'thread' }] };
  } });
  assert.equal(result.next.used, 1); assert.equal(result.next.limit, 1); assert.equal(result.next.pageToken, 'next');
  await collectGmail({ user: 'kim@orgiast.jp', limit: 1, state: result.next, now, search: () => assert.fail('daily cap') });
});

test('Gmail窓queryは初回だけnewer_thanを使い旧queryを救済する', async () => {
  const seen = [];
  for (const state of [{}, { watermark: '2026-11-03T00:00:00Z' }, { watermark: '2026-11-03T00:00:00Z', query: 'newer_than:3d old' }]) await collectGmail({ user: 'kim@orgiast.jp', state, now, search: async o => { seen.push(o.query); return { messages: [] }; } });
  assert.match(seen[0], /newer_than:3d/); assert.match(seen[0], /before:/);
  for (const query of seen.slice(1)) { assert.doesNotMatch(query, /newer_than/); assert.match(query, /after:/); assert.match(query, /before:/); }
});

test('config上限をloaderから渡しDrive pageSizeにも反映する', async () => {
  const state = { sources: {} }, config = { mailboxes: ['mail'], driveUsers: ['drive'], lineSheets: [], gmailDailyLimit: 5, driveDailyLimit: 7 };
  const loaders = sourceLoaders({ home: '', config, state, now, sheets: {}, request: async url => { assert.match(url, /pageSize=7/); return { files: [] }; }, search: async o => { assert.equal(o.max, 100); return { messages: [{ subject: '通常連絡' }] }; } });
  assert.equal((await loaders[0].load()).next.limit, 5); assert.equal((await loaders[0].load()).next.used, 0);
  assert.equal((await loaders[1].load()).next.limit, 7);
});

test('Drive OCRはコピーだけ削除、export失敗でも後始末、dry-runはコピーなし', async () => {
  const calls = [];
  const file = { id: 'original', mimeType: 'application/pdf' };
  const request = async (url, o) => { calls.push([url,o]); if (url.includes('/permissions')) return { permissions: [{ type: 'user', emailAddress: 'kim@orgiast.jp', role: 'owner' }] }; if (o.method === 'PATCH') return {};  if (o.method === 'POST') return { id: 'temporary' }; if (o.method === 'DELETE') return null; throw Error('export failed'); };
  await assert.rejects(readDriveText(file, { user: 'kim@orgiast.jp', request }), /export failed/);
  assert.match(calls.at(-1)[0], /temporary$/); assert.equal(calls.at(-1)[1].method, 'DELETE');
  assert.equal(await readDriveText(file, { dryRun: true, request: () => assert.fail('mutation') }), '');
  assert.ok(Buffer.byteLength(trimBytes('あ'.repeat(30000))) <= 30000);
});

test('Driveの1ファイルreadDriveText失敗でも残りは処理されskipped・nextが返る', async () => {
  const files = [
    { id: 'ok-1', name: 'ok1.pdf', mimeType: 'application/pdf', modifiedTime: '2026-11-04T01:00:00Z', webViewLink: 'https://drive.google.com/file/d/ok-1/view' },
    { id: 'fail-1', name: 'big.pdf', mimeType: 'application/pdf', modifiedTime: '2026-11-04T02:00:00Z', webViewLink: 'https://drive.google.com/file/d/fail-1/view' },
    { id: 'ok-2', name: 'ok2.pdf', mimeType: 'application/pdf', modifiedTime: '2026-11-04T03:00:00Z', webViewLink: 'https://drive.google.com/file/d/ok-2/view' },
  ];
  const request = async (url, opts) => {
    // files.list call
    if (url.includes('drive/v3/files?') && !url.includes('/copy') && !url.includes('/export')) {
      return { files, nextPageToken: 'next-token' };
    }
    // OCR copy: POST
    if (opts?.method === 'POST' && url.includes('/copy')) {
      const match = url.match(/files\/([^/]+)\/copy/);
      if (match[1] === 'fail-1') throw new Error('The operation was aborted due to timeout');
      return { id: `copy-${match[1]}` };
    }
    // export: GET
    if (url.includes('/export')) {
      return 'extracted text';
    }
    // DELETE temporary copy
    if (opts?.method === 'DELETE') return null;
    // ensureKimEditor permissions check
    if (url.includes('/permissions')) return { permissions: [{ type: 'user', emailAddress: 'kim@orgiast.jp', role: 'owner' }] };
    return {};
  };
  const result = await collectDrive({ user: 'kim@orgiast.jp', state: {}, now: new Date('2026-11-04T04:00:00Z'), request });
  // 2 files succeeded
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0].sourceRef, 'drive:ok-1');
  assert.equal(result.documents[1].sourceRef, 'drive:ok-2');
  // 1 file skipped
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].sourceRef, 'drive:fail-1');
  assert.match(result.skipped[0].reason, /Drive読み取り失敗/);
  // next watermark is saved
  assert.ok(result.next);
  assert.equal(result.next.pageToken, 'next-token');
});

test('Driveの1ファイルreadDriveText失敗でもrunDetectでskippedが積まれerrorsに入らない', async t => {
  const home = homeFor(t), state = {}, rows = [], candidates = [];
  const ledger = { read: async tab => [...(tab === '候補' ? candidates : rows)], append: async (newRows, tab) => (tab === '候補' ? candidates : rows).push(...newRows) };
  const request = async (url, opts) => {
    // files.list
    if (url.includes('drive/v3/files?') && !url.includes('/copy') && !url.includes('/export')) {
      return { files: [
        { id: 'fail-1', name: 'big.pdf', mimeType: 'application/pdf', modifiedTime: '2026-11-04T02:00:00Z', webViewLink: 'https://drive.google.com/file/d/fail-1/view' },
      ], nextPageToken: 'next-token' };
    }
    // OCR copy
    if (opts?.method === 'POST' && url.includes('/copy')) throw new Error('The operation was aborted due to timeout');
    // DELETE
    if (opts?.method === 'DELETE') return null;
    return {};
  };
  const sources = [{ key: 'drive:kim@orgiast.jp', load: () => collectDrive({ user: 'kim@orgiast.jp', state: {}, now: new Date('2026-11-04T04:00:00Z'), request }) }];
  const params = { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger, state, sources, now: new Date('2026-11-04T04:00:00Z'), dryRun: false, ask: async () => ({ items: [] }), notify: async () => {} };
  const result = await runDetect(params);
  // No items added (no successful documents to extract from)
  assert.equal(result.added, 0);
  // errors is empty — file-level failure is skipped, not an error
  assert.equal(result.errors.length, 0);
  // skipped contains the file that timed out
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].source, 'drive:kim@orgiast.jp');
  assert.match(result.skipped[0].reason, /Drive読み取り失敗/);
  // next is saved in state (even though all files failed — the window advances)
  assert.ok(state.sources['drive:kim@orgiast.jp']);
  assert.equal(state.sources['drive:kim@orgiast.jp'].pageToken, 'next-token');
});

test('Driveは時間予算到達をpartial成功にし、次回は同じページの未処理分から再開', async () => {
  const files = ['one', 'two'].map((id, i) => ({ id, name: `${id}.gdoc`, mimeType: 'application/vnd.google-apps.document', modifiedTime: `2026-11-04T0${i + 1}:00:00Z` }));
  const read = [];
  const request = async (url) => {
    if (url.includes('drive/v3/files?')) return { files, nextPageToken: 'page-2' };
    const id = url.match(/files\/([^/]+)\/export/)?.[1]; read.push(id); return `${id} text`;
  };
  const ticks = [0, 0, 10];
  const first = await collectDrive({ user: 'kim@example.invalid', state: {}, now, request, budgetMs: 5, nowMs: () => ticks.shift() ?? 10 });
  assert.equal(first.documents.length, 1); assert.equal(first.partial.reason, 'Drive時間予算到達');
  assert.deepEqual(first.next.processedIds, ['one']); assert.equal(first.next.pageToken, undefined);
  const second = await collectDrive({ user: 'kim@example.invalid', state: first.next, now, request, budgetMs: 100, nowMs: () => 0 });
  assert.deepEqual(read, ['one', 'two']); assert.equal(second.documents.length, 1); assert.equal(second.documents[0].sourceRef, 'drive:two');
  assert.equal(second.next.pageToken, 'page-2'); assert.equal(second.next.processedIds, undefined);
});

test('全体上限では残sourceをskipしてexit 0・heartbeat okにする', async t => {
  const home = homeFor(t), output = [], heartbeats = [], ticks = [0, 0, 600_000];
  const sources = [
    { key: 'done', load: async () => ({ documents: [], next: { watermark: 'done' } }) },
    { key: 'later', load: async () => assert.fail('全体上限後のsourceを開始しない') },
  ];
  const code = await main([], { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger: { read: async () => [] }, sources, skipSeatCheck: true, nowMs: () => ticks.shift() ?? 600_000, stdout: value => output.push(value), heartbeat: async value => heartbeats.push(value), notify: async () => {} });
  assert.equal(code, 0); const result = JSON.parse(output[0]);
  assert.equal(result.partial.length, 1); assert.match(result.skipped[0].reason, /全体時間上限/);
  assert.equal(heartbeats[0].ok, true); assert.match(heartbeats[0].summary, /partial=1 skipped=1/);
});

test('DEADLINE_TOTAL_BUDGET_MSで全体上限を設定できる', async t => {
  const previous = process.env.DEADLINE_TOTAL_BUDGET_MS;
  process.env.DEADLINE_TOTAL_BUDGET_MS = '40';
  t.after(() => previous === undefined ? delete process.env.DEADLINE_TOTAL_BUDGET_MS : process.env.DEADLINE_TOTAL_BUDGET_MS = previous);
  const home = homeFor(t), output = [];
  const code = await main([], { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger: { read: async () => [] },
    sources: [{ key: 'hang', load: async () => new Promise(() => {}) }], skipSeatCheck: true,
    stdout: value => output.push(JSON.parse(value)), heartbeat: async () => {}, notify: async () => {} });
  assert.equal(code, 0); assert.match(output[0].skipped[0].reason, /全体時間上限/);
});

test('token取得不可で全体が成立しない場合はexit 1のまま', async t => {
  const home = homeFor(t), heartbeats = [];
  const code = await main([], { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger: { read: async () => { throw new Error('token unavailable'); } }, sources: [], skipSeatCheck: true, stderr: () => {}, stdout: () => {}, heartbeat: async value => heartbeats.push(value) });
  assert.equal(code, 1); assert.equal(heartbeats[0].ok, false); assert.match(heartbeats[0].summary, /token unavailable/);
});

test('Driveの50件上限とLINE/Discordの新規行を読み込む', async t => {
  const result = await collectDrive({ user: 'kim@orgiast.jp', state: {}, now, limit: 50, request: async (url) => { assert.match(url, /pageSize=50/); return { files: [], nextPageToken: 'next' }; } });
  assert.equal(result.next.pageToken, 'next'); assert.equal(result.next.watermark, undefined);
  const line = await collectLine({ sheetId: 'sheet', state: { watermark: '2026-11-03T00:00:00Z' }, now, sheets: { get: async () => [['id','ts','text'], ['new', now.getTime()-1, '明日まで'], ['old', Date.parse('2026-11-02'), '過去']] } });
  assert.equal(line.documents.length, 1); assert.match(line.documents[0].sourceRef, /new$/);
  const home = homeFor(t); fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/discord-inbox-state.json'), JSON.stringify({ cursor: 'x' }));
  fs.writeFileSync(path.join(home, '.claude/pending-decisions.jsonl'), JSON.stringify({ id: 'd', source: 'discord-inbox', capturedAt: now.toISOString(), text: '期限は明日' }) + '\n');
  assert.equal((await collectDiscord({ home, state: {}, now })).documents.length, 1);
});

test('Driveの既定150件上限とLINE/Discordの新規行を読み込む', async t => {
  const result = await collectDrive({ user: 'kim@orgiast.jp', state: {}, now, request: async (url) => { assert.match(url, /pageSize=150/); return { files: [], nextPageToken: 'next' }; } });
  assert.equal(result.next.pageToken, 'next'); assert.equal(result.next.watermark, undefined);
  const line = await collectLine({ sheetId: 'sheet', state: { watermark: '2026-11-03T00:00:00Z' }, now, sheets: { get: async () => [['id','ts','text'], ['new', now.getTime()-1, '明日まで'], ['old', Date.parse('2026-11-02'), '過去']] } });
  assert.equal(line.documents.length, 1); assert.match(line.documents[0].sourceRef, /new$/);
  const home = homeFor(t); fs.mkdirSync(path.join(home,'.claude'));
  fs.writeFileSync(path.join(home,'.claude/discord-inbox-state.json'), JSON.stringify({ lastIntakeAt: now.toISOString() }));
  fs.writeFileSync(path.join(home,'.claude/pending-decisions.jsonl'), JSON.stringify({ id:'one', source:'discord-inbox', capturedAt: now.toISOString(), text:'回答期限は11/5' })+'\n');
  assert.equal((await collectDiscord({ home, now })).documents.length, 1);
});

test('遅れた窓は複数ページを読み完了し通常窓は1ページだけ読む', async () => {
  const oldNow = new Date('2026-11-10T00:00:00Z'), gmailTokens = [];
  const gmail = await collectGmail({ user: 'mail', state: { watermark: '2026-11-01T00:00:00Z', until: '2026-11-02T00:00:00Z' }, now: oldNow, search: async o => {
    gmailTokens.push(o.pageToken); return o.pageToken ? { messages: [] } : { messages: [], nextPageToken: 'g2' };
  } });
  assert.deepEqual(gmailTokens, [undefined, 'g2']); assert.equal(gmail.next.watermark, '2026-11-02T00:00:00Z');
  assert.equal('until' in gmail.next, false); assert.equal('query' in gmail.next, false); assert.equal('pageToken' in gmail.next, false);
  let recentCalls = 0;
  const recent = await collectGmail({ user: 'mail', state: { watermark: '2026-11-09T12:00:00Z' }, now: oldNow, search: async () => { recentCalls++; return { messages: [], nextPageToken: 'later' }; } });
  assert.equal(recentCalls, 1); assert.equal(recent.next.pageToken, 'later');
  const driveTokens = [];
  const drive = await collectDrive({ user: 'drive', state: { watermark: '2026-11-01T00:00:00Z', until: '2026-11-02T00:00:00Z' }, now: oldNow, request: async url => {
    const token = new URL(url).searchParams.get('pageToken'); driveTokens.push(token); return token ? { files: [] } : { files: [], nextPageToken: 'd2' };
  } });
  assert.deepEqual(driveTokens, [null, 'd2']); assert.equal(drive.next.watermark, '2026-11-02T00:00:00Z'); assert.equal('until' in drive.next, false);
});

test('runDetectは2日超のGmail/Drive遅れを1回だけ通知し解消時に印を消す', async t => {
  const home = homeFor(t), state = {}, notices = [], now = new Date('2026-11-10T00:00:00Z');
  const ledger = { read: async () => [], append: async () => {} };
  const sources = [{ key: 'gmail:mail', load: async () => ({ documents: [], next: { watermark: '2026-11-01T00:00:00Z' } }) }];
  const params = { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger, state, sources, now, dryRun: false, ask: async () => ({ items: [] }), notify: async (_home, notice) => notices.push(notice) };
  await runDetect(params); await runDetect(params);
  assert.equal(notices.filter(n => n.source === 'deadline-lag').length, 1); assert.equal(notices[0].dedupeKey, 'deadline-lag:2026-11-10'); assert.match(notices[0].text, /gmail:mail: 2026-11-01/);
  sources[0].load = async () => ({ documents: [], next: { watermark: now.toISOString() } });
  await runDetect(params); assert.equal(state.lagNoticeAt, undefined);
});

test('旧LINE受信ログの日本語見出しも期限検出へ正規化する', async () => {
  const now = new Date('2026-11-07T00:00:00Z');
  const calls = [];
  const sheets = { get: async (_id, range) => {
    calls.push(range);
    if (range.startsWith('Messages!')) throw new Error('Sheets GET HTTP 400');
    return [
      ['受信日時(JST)','グループ名','スレッドID','表示名','方向','本文','添付の保存パス','メッセージID'],
      ['2026-11-06T12:00:00+09:00','','thread','担当者','受信','11月10日までに回答','','legacy-1'],
    ];
  } };
  const result = await collectLine({ sheetId: 'legacy', state: { watermark: '2026-11-05T00:00:00Z' }, now, sheets });
  assert.deepEqual(calls, ['Messages!A:H', "'受信ログ'!A:H"]);
  assert.equal(result.documents[0].sourceRef, 'line:legacy:legacy-1');
  assert.equal(result.documents[0].text, '担当者: 11月10日までに回答');
})

test('Driveの旧ページトークンが無効なら固定条件の先頭から再開する', async () => {
  const urls = [];
  const result = await collectDrive({ user: 'kim@orgiast.jp',
    state: { day: '2026-11-03', used: 50, until: '2026-11-03T02:00:00Z', pageToken: 'expired' }, now,
    request: async url => { urls.push(url); if (urls.length === 1) throw new Error('Google GET HTTP 400'); return { files: [], nextPageToken: 'next' }; } });
  assert.match(urls[0], /pageToken=expired/);
  assert.doesNotMatch(urls[1], /pageToken=/);
  assert.equal(result.next.pageToken, 'next');
  assert.match(result.next.query, /modifiedTime/);
})

test('不存在のfixtureで本番ソースへfallbackしない', async t => {
  const home=homeFor(t), errors=[];
  assert.equal(await main(['--dry-run','--fixture',home],{home,config:{...DEFAULT_CONFIG,sheetId:'live'},stderr:e=>errors.push(e),search:()=>assert.fail('live read')}),1);
  assert.match(errors[0],/fixture/); assert.deepEqual(fs.readdirSync(home),[]);
});

test('鍵なし席はseat checkでスキップされる', async t => {
  const home=homeFor(t), output=[], heartbeats=[];
  fs.writeFileSync(path.join(home,'.claude.json'), JSON.stringify({oauthAccount:{emailAddress:'seisaku-team@orgiast.jp'}}));
  // Inject a seatCheck that uses a non-existent key path so it never hits the real DWD key.
  const code = await main(['--now','2026-11-04'], { home, stdout: x => output.push(x), skipSeatCheck: false, search: () => assert.fail('no network'), heartbeat: async (info) => heartbeats.push(info), notify: () => assert.fail('no notify'), seatCheck: (h) => seatCheck(h, { keyPath: path.join(home, 'nonexistent-key.json') }) });
  assert.equal(code, 0);
  const result = JSON.parse(output[0]);
  assert.equal(result.skip, true);
  assert.match(result.reason, /スキップ/);
  assert.equal(heartbeats.length, 1);
  assert.match(heartbeats[0].summary, /スキップ/);
});

test('引用不一致1件混ざってもdryRun:falseでnextが保存される', async t => {
  const home = homeFor(t), state = {}, rows = [], candidates = [];
  const ledger = { read: async tab => [...(tab === '候補' ? candidates : rows)], append: async (newRows, tab) => (tab === '候補' ? candidates : rows).push(...newRows) };
  const goodDoc = { source: 'Gmail', sourceRef: 'mail:good', date: '2026-11-03T23:00:00Z', text: '明日までに回答してください。', mailbox: 'kim@orgiast.jp', threadId: 't1' };
  const badDoc = { source: 'Gmail', sourceRef: 'mail:bad', date: '2026-11-03T23:00:00Z', text: '本日中に対応します。', mailbox: 'kim@orgiast.jp', threadId: 't2' };
  const goodItem = { sourceRef: 'mail:good', title: '回答', due: '2026-11-05', kind: '回答・返信', action: '返信', assignee: 'kim', confidence: 0.9, quote: '明日までに回答してください。' };
  const badItem = { sourceRef: 'mail:bad', title: '架空の期限', due: '2026-11-05', kind: '回答・返信', action: '対応', assignee: 'kim', confidence: 0.9, quote: '原文にない引用' };
  const sources = [{ key: 'gmail', load: async () => ({ documents: [goodDoc, badDoc], next: { watermark: '2026-11-04' } }) }];
  const params = { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger, state, sources, now, dryRun: false, ask: async () => ({ items: [goodItem, badItem], skipped: [] }), notify: async () => {} };
  const result = await runDetect(params);
  // Good item was added
  assert.equal(result.added, 1);
  // Bad item was skipped (quote mismatch), not in errors
  assert.equal(result.errors.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /引用が原文にありません/);
  assert.equal(result.skipped[0].sourceRef, 'mail:bad');
  // dryRun:false — next cursor was saved in state
  assert.deepEqual(state.sources.gmail, { watermark: '2026-11-04' });
  // Good item was appended to rows
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceId, 'mail:good');
  assert.equal(rows[0].status, '未着手');
});

test('鍵持ちのkim席はfixtureモードで通常動作（fixtureはseat checkをスキップ）', async t => {
  const home=homeFor(t), output=[];
  const code = await main(['--dry-run','--fixture','tools/fixtures/deadline/'], { home, stdout: x => output.push(x), skipSeatCheck: false, request: () => assert.fail('network'), heartbeat: () => assert.fail('heartbeat'), notify: () => assert.fail('notify') });
  assert.equal(code, 0);
  const result = JSON.parse(output[0]);
  assert.equal(result.skip, undefined);
  assert.equal(result.added, 5);
});

test('「」引用符の値が正しくパースされる', () => {
  const input = `{"items":[{"title":「回答」,"due":「2026-12-01」,"kind":「回答・返信」,"action":「返信」,"assignee":「kim」,"confidence":0.9,"quote":「明日までに」,"sourceRef":「mail:test」}]}`;
  const result = parseExtraction(input);
  assert.equal(result.items[0].title, '回答');
  assert.equal(result.items[0].due, '2026-12-01');
  assert.equal(result.items[0].quote, '明日までに');
});

test('「」引用符と通常のJSON引用符が混在しても正しくパースされる', () => {
  const input = '{"items":[{"title":"「見積書」提出","due":"2026-12-01","kind":"回答・返信","action":"返信","assignee":"kim","confidence":0.9,"quote":"「見積書」を提出","sourceRef":"mail:test"}]}';
  const result = parseExtraction(input);
  assert.equal(result.items[0].title, '「見積書」提出');
  assert.equal(result.items[0].due, '2026-12-01');
  assert.equal(result.items[0].quote, '「見積書」を提出');
});

test('「」引用符の値と通常の値が混在しても正しくパースされる', () => {
  const input = `{"items":[{"title":「回答」,"due":"2026-12-01","kind":"回答・返信","action":"返信","assignee":"kim","confidence":0.9,"quote":"「明日までに」提出","sourceRef":"mail:test"}]}`;
  const result = parseExtraction(input);
  assert.equal(result.items[0].title, '回答');
  assert.equal(result.items[0].due, '2026-12-01');
  assert.equal(result.items[0].quote, '「明日までに」提出');
});

test('「」引用符の中のダブルクォートとバックスラッシュをエスケープする', () => {
  const input = String.raw`{"items":[{"title":「A"B\C」,"due":"2026-12-01","kind":"回答・返信","confidence":0.9,"quote":"原文","sourceRef":"mail:test"}]}`;
  assert.equal(parseExtraction(input).items[0].title, String.raw`A"B\C`);
});

test('配列要素も「」引用符でパースされる', () => {
  const input = `{"items":[「test1」,{"title":"回答","due":"2026-12-01","kind":"回答・返信","action":"返信","assignee":"kim","confidence":0.9,"quote":"原文","sourceRef":"mail:test"}]}`;
  // これは items の型チェックで弾かれる（items がオブジェクトの配列でない）
  // フォールバックを通るだけで parseExtraction のバリデーションで throw することを確認
  assert.throws(() => parseExtraction(input), /itemsが不正です/);
});

test('壊れたJSONは従来どおり例外を投げる', () => {
  assert.throws(() => parseExtraction('not json at all'), SyntaxError);
  assert.throws(() => parseExtraction('{"items":['), SyntaxError);
});

test('partial Driveもmainでexit 0・heartbeatへ件数と理由を残す', async t => {
  const home = homeFor(t), heartbeats = [];
  const code = await main([], { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, skipSeatCheck: true,
    ledger: { read: async () => [] }, sources: [{ key: 'drive', load: async () => ({ documents: [], next: { processedIds: ['one'] }, partial: { reason: 'Drive時間予算到達', processed: 1, remaining: 2 }, skipped: [{ reason: 'file timeout' }] }) }],
    stdout: () => {}, stage: () => {}, heartbeat: async value => heartbeats.push(value) });
  assert.equal(code, 0); assert.equal(heartbeats[0].ok, true);
  assert.match(heartbeats[0].summary, /partial=1 skipped=1/);
  assert.match(heartbeats[0].summary, /Drive時間予算到達/); assert.match(heartbeats[0].summary, /file timeout/);
});

test('per-file timeoutで応答しないファイルをskipし次のファイルへ進む', async t => {
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  const result = await collectDrive({ user: 'test', now, state: {}, perFileTimeoutMs: 30,
    request: async url => {
      if (url.includes('files?')) return { files: ['hang', 'ok'].map(id => ({ id, name: id, mimeType: 'application/vnd.google-apps.document' })) };
      if (url.includes('/hang/')) return new Promise(() => {});
      return 'text';
    } });
  assert.equal(result.skipped.length, 1); assert.equal(result.skipped[0].sourceRef, 'drive:hang');
  assert.equal(result.documents[0].sourceRef, 'drive:ok'); assert.equal(result.next.used, 2);
});

test('Drive処理中の全体abortでも取得済みdocumentと未処理位置を返す', async () => {
  const controller = new AbortController();
  const result = await collectDrive({ user: 'test', now, state: {}, signal: controller.signal,
    request: async url => {
      if (url.includes('files?')) return { files: ['one', 'two'].map(id => ({ id, name: id, mimeType: 'application/vnd.google-apps.document' })) };
      // Abort after the first file has returned, before the next file starts.
      return 'text';
    }, onStage: message => { if (message.endsWith('file one end')) controller.abort(new Error('process limit')); } });
  assert.equal(result.documents.length, 1); assert.match(result.partial.reason, /全体時間上限/);
  assert.deepEqual(result.next.processedIds, ['one']); assert.equal(result.next.used, 1);
});

test('partial再開で日次件数を二重計数せず次ページへ進める', async () => {
  const result = await collectDrive({ user: 'test', now, state: { day: '2026-11-04', used: 1, processedIds: ['one'] },
    request: async url => url.includes('files?') ? { files: ['one', 'two'].map(id => ({ id, name: id, mimeType: 'application/vnd.google-apps.document' })), nextPageToken: 'next' } : 'text' });
  assert.equal(result.documents.length, 1); assert.equal(result.next.used, 2); assert.equal(result.next.pageToken, 'next');
});

test('待機中sourceを実時間の全体上限で止め残sourceをskipする', async t => {
  const home = homeFor(t), heartbeats = [], output = [], started = Date.now();
  const code = await main([], { home, processBudgetMs: 40, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, skipSeatCheck: true,
    ledger: { read: async () => [] }, sources: [
      { key: 'hang', load: async () => new Promise(() => {}) },
      { key: 'later', load: () => assert.fail('must not start') },
    ], stdout: value => output.push(JSON.parse(value)), stage: () => {}, heartbeat: async value => heartbeats.push(value) });
  assert.equal(code, 0); assert.equal(heartbeats[0].ok, true); assert.equal(output[0].skipped.length, 2);
  assert.ok(Date.now() - started < 1000);
});

test('LLM待機も全体上限で止め、保存本文を次回再利用して未処理batchから続く', async t => {
  const home = homeFor(t), heartbeats = [], seen = [];
  const docs = Array.from({ length: 11 }, (_, i) => ({ ...document, sourceRef: `doc:${i}` }));
  let loads = 0;
  const deps = { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, skipSeatCheck: true,
    ledger: { read: async () => [] }, sources: [{ key: 'drive', load: async () => ({ documents: ++loads === 1 ? docs : [], next: { watermark: 'done' } }) }],
    stdout: () => {}, stage: () => {}, heartbeat: async value => heartbeats.push(value) };
  let batches = 0;
  assert.equal(await main([], { ...deps, processBudgetMs: 60, ask: async (_provider, batch) => {
    seen.push(batch.map(d => d.sourceRef)); return ++batches === 1 ? { items: [] } : new Promise(() => {});
  } }), 0);
  const saved = JSON.parse(fs.readFileSync(dataPath(home, 'state.json'), 'utf8'));
  assert.equal(saved.pending.drive.documents.length, 1); assert.equal(saved.sources?.drive, undefined);
  assert.equal(await main([], { ...deps, ask: async (_provider, batch) => { seen.push(batch.map(d => d.sourceRef)); return { items: [] }; } }), 0);
  assert.deepEqual(seen.map(batch => batch.length), [10, 1, 1]); assert.equal(loads, 2);
  const finished = JSON.parse(fs.readFileSync(dataPath(home, 'state.json'), 'utf8'));
  assert.equal(finished.pending.drive, undefined); assert.equal(finished.sources.drive.watermark, 'done');
  assert.ok(heartbeats.every(value => value.ok));
});

test('source失敗は他source成功時exit 0でも実際の理由をheartbeatに残す', async t => {
  const home = homeFor(t), heartbeats = [];
  const code = await main([], { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, skipSeatCheck: true,
    ledger: { read: async () => [] }, sources: [
      { key: 'broken', load: async () => { throw new Error('source offline'); } },
      { key: 'good', load: async () => ({ documents: [], next: {} }) },
    ], stdout: () => {}, stage: () => {}, heartbeat: async value => heartbeats.push(value) });
  assert.equal(code, 0); assert.equal(heartbeats[0].ok, true); assert.match(heartbeats[0].summary, /broken: source offline/);
});

test('先行source成功後でも台帳書込失敗はexit 1・heartbeat false', async t => {
  const home = homeFor(t), heartbeats = [];
  const code = await main([], { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, skipSeatCheck: true,
    ledger: { read: async () => [], append: async () => { throw new Error('append unavailable'); } },
    sources: [{ key: 'good', load: async () => ({ documents: [], next: {} }) }, { key: 'write', load: async () => ({ documents: [document], next: {} }) }],
    ask: async () => ({ items: [item] }), stdout: () => {}, stderr: () => {}, stage: () => {}, heartbeat: async value => heartbeats.push(value) });
  assert.equal(code, 1); assert.equal(heartbeats[0].ok, false); assert.match(heartbeats[0].summary, /台帳書込失敗.*append unavailable/);
});

test('Sheets token取得が実際に拒否される場合はexit 1・heartbeat false', async t => {
  const home = homeFor(t), heartbeats = [];
  const sheets = createSheetsClient({ getToken: async () => { throw new Error('credentials unavailable'); }, fetchImpl: () => assert.fail('no token') });
  const code = await main([], { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, skipSeatCheck: true, sheets, sources: [],
    stdout: () => {}, stderr: () => {}, stage: () => {}, heartbeat: async value => heartbeats.push(value) });
  assert.equal(code, 1); assert.equal(heartbeats[0].ok, false); assert.match(heartbeats[0].summary, /Sheets token failed.*credentials unavailable/);
});

test('全体上限のpartialは先行source失敗があってもexit 0で理由を保持', async t => {
  const home = homeFor(t), heartbeats = [];
  const code = await main([], { home, processBudgetMs: 40, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, skipSeatCheck: true,
    ledger: { read: async () => [] }, sources: [
      { key: 'broken', load: async () => { throw new Error('source unavailable'); } },
      { key: 'hang', load: async () => new Promise(() => {}) },
    ], stdout: () => {}, stage: () => {}, heartbeat: async value => heartbeats.push(value) });
  assert.equal(code, 0); assert.equal(heartbeats[0].ok, true);
  assert.match(heartbeats[0].summary, /source unavailable/); assert.match(heartbeats[0].summary, /全体時間上限/);
});

test('状態ファイル書込失敗はsource成功で隠さずexit 1', async t => {
  const home = homeFor(t), heartbeats = [];
  const code = await main([], { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, skipSeatCheck: true,
    ledger: { read: async () => [] }, sources: [{ key: 'drive', load: async () => {
      fs.mkdirSync(dataPath(home, 'state.json'), { recursive: true });
      return { documents: [], next: {} };
    } }], stdout: () => {}, stderr: () => {}, stage: () => {}, heartbeat: async value => heartbeats.push(value) });
  assert.equal(code, 1); assert.equal(heartbeats[0].ok, false); assert.match(heartbeats[0].summary, /状態書込失敗/);
});

test('Gmail sourceのタイムアウトはpartialになりerrorにならない', async t => {
  const home = homeFor(t), state = {}, stages = [];
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const sources = [
    { key: 'gmail:kim@orgiast.jp', load: async () => { throw timeout; } },
    { key: 'discord', load: async () => ({ documents: [], next: { watermark: 'done' } }) },
  ];
  const ledger = { read: async () => [], append: async () => {} };
  const result = await runDetect({ home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger, state, sources, now, dryRun: false, ask: async () => assert.fail('no LLM'), notify: async () => {}, stage: value => stages.push(value) });
  // Timeout → partial, not error
  assert.equal(result.errors.length, 0);
  assert.equal(result.partial.length, 1);
  assert.match(result.partial[0].reason, /一時的エラー/);
  assert.match(result.skipped[0].reason, /一時的エラー/);
  // Non-Gmail source was processed
  assert.deepEqual(state.sources.discord, { watermark: 'done' });
});

test('Gmail sourceの全メッセージタイムアウトはrunDetectでpartial（複数source）', async t => {
  const home = homeFor(t), heartbeats = [];
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const code = await main([], { home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, skipSeatCheck: true,
    ledger: { read: async () => [] }, sources: [
      { key: 'gmail:kim@orgiast.jp', load: async () => { throw timeout; } },
      { key: 'gmail:seisaku-team@orgiast.jp', load: async () => { throw timeout; } },
      { key: 'drive:kim@orgiast.jp', load: async () => ({ documents: [], next: { watermark: 'done' }, partial: { reason: 'Drive時間予算到達', processed: 1 } }) },
    ], stdout: () => {}, stderr: () => {}, stage: () => {}, heartbeat: async value => heartbeats.push(value) });
  // Partial source(s) → exit 0
  assert.equal(code, 0);
  assert.equal(heartbeats[0].ok, true);
  // Both gmail sources are partial, not error
  assert.match(heartbeats[0].summary, /partial=3/);
  assert.doesNotMatch(heartbeats[0].summary, /errors=[1-9]/);
});

test('認証エラーはerrorのまま（transientではない）', async t => {
  const home = homeFor(t);
  const authError = Object.assign(new Error('Gmail API 401: Unauthorized'), { status: 401 });
  const sources = [{ key: 'gmail:kim@orgiast.jp', load: async () => { throw authError; } }];
  const ledger = { read: async () => [], append: async () => {} };
  const result = await runDetect({ home, config: { ...DEFAULT_CONFIG, sheetId: 'test' }, ledger, sources, state: {}, now, dryRun: false, ask: async () => assert.fail('no LLM'), notify: async () => {} });
  assert.equal(result.errors.length, 1);
  assert.equal(result.partial.length, 0);
});
