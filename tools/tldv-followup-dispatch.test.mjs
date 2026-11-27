import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as api from './tldv-followup-dispatch.mjs';

const { isExcludedTitle, meetingEnd, selectCandidates, transcriptReady, matchCalendarEvent, customerName,
  classifyFollowup, resolveFollowupCase, routeFollowup, folderName, renderPrompt, writeBomUtf8, appendLedgerItems,
  collectDraftReplies, planRun, dispatch, renderStatus, main, executeLocalFollowup } = api;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config/tldv-followup-routing.json'), 'utf8'));
const now = Date.parse('2026-11-26T04:00:00Z');
const meeting = (extra = {}) => ({ id: 'm1', name: '顧客株式会社 展示会ブース 打合せ', happenedAt: '2026-11-26T01:00:00Z', duration: 3600,
  invitees: [{ email: 'guest@example.com', name: '田中' }], ...extra });
const caseRow = { id: 'C1234', name: '展示会ブース', client: '顧客株式会社', phase: '制作中' };
const pcMap = { 'w018-PC': { remoteName: '作業用018' }, '作業用011': {}, DELL: { remoteName: '作業用014' }, '008XPS8300': { remoteName: '作業用008', aliases: ['作業用008'] } };
const transcript = { data: [{ text: '明日までに見積を作る', speaker: '田中' }] };
const ready = (extra = {}) => planRun({ meetings: [meeting()], state: {}, now, config, events: [], cases: [caseRow], pcMap,
  fetchTranscript: async () => transcript, fetchNotes: async () => ({ markdownContent: '見積作成' }), ...extra });
function temp(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tldv-followup-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const receiver = method => ({ observedAt: new Date(Date.now() - 60000).toISOString(), accept: [method === 'fleet-mail' ? 'claude-resume' : 'prompt'],
  hub: 'kim-PC', cwd: 'C:\\repo', mailAvailable: true, directiveAvailable: true });
const ledgerItem = (n = 1) => ({ meetingId: 'm1', n, id: `tldv:m1:${n}`, to: 'guest@example.com', body: 'お打合せありがとうございました。',
  client: '顧客株式会社', case: '展示会ブース', subject: '打合せの確認', channel: 'email', after: '2026-11-26T02:00:00Z' });
function deps(home, extra = {}) {
  return { home, now, out: () => {}, host: 'test-PC', pcMap,
    client: { listMeetings: async () => [meeting()], transcript: async () => transcript, notes: async () => ({ markdownContent: 'メモ' }) },
    createGoogle: options => options, loadEvents: async () => ({ events: [], errors: [] }), loadCasesWithRetry: async () => [caseRow],
    inspectFleet: async () => ({ inbox: [], receivers: { DELL: receiver('fleet-mail') }, beacons: [] }),
    send: async () => ({ id: 'mail-test' }), runLocal: async () => ({ report: '下書き', drafts: [] }), ...extra };
}
function snapshot(home) {
  if (!fs.existsSync(home)) return {};
  const result = {};
  for (const name of fs.readdirSync(home, { recursive: true })) {
    const file = path.join(home, name);
    if (fs.statSync(file).isFile()) result[name] = fs.readFileSync(file).toString('base64');
  }
  return result;
}

test('新規検知: 終了・猶予・lookback・処理済み・保留・対象外・重複ID', () => {
  const meetings = [meeting(), meeting(), meeting({ id: 'ongoing', duration: 20000 }), meeting({ id: 'recent', happenedAt: '2026-11-26T03:56:00Z', duration: 0 }),
    meeting({ id: 'old', happenedAt: '2026-11-21T00:00:00Z' }), ...['done', 'skipped', 'held'].map(id => meeting({ id }))];
  const result = selectCandidates(meetings, { processed: { done: {} }, skipped: { skipped: {} }, held: { held: {} } }, { now, config });
  assert.deepEqual(result.candidates.map(m => m.id), ['m1']);
  assert.equal(meetingEnd(meeting()), Date.parse('2026-11-26T02:00:00Z'));
  assert.equal(meetingEnd(meeting({ duration: undefined })), Date.parse(meeting().happenedAt));
});
test('除外タイトルはexcludedに分離しskippedに保存', async () => {
  const state = {}, meetings = ['採用面談', '朝の瞑想'].map((name, i) => meeting({ id: `x${i}`, name }));
  assert.ok(isExcludedTitle('採用面談', config.excludeTitlePatterns));
  assert.equal(selectCandidates(meetings, state, { now, config }).excluded.length, 2);
  const rows = await ready({ meetings, state, fetchTranscript: () => assert.fail('excludedを取得しない') });
  assert.ok(rows.every(r => r.status === 'excluded')); assert.equal(Object.keys(state.skipped).length, 2);
});
test('transcript: 空配列と例外はpending、試行増加、48hでgave-up', async () => {
  assert.equal(transcriptReady({ data: [{ text: ' ' }, {}] }), false);
  assert.equal(transcriptReady(transcript), true);
  const state = {};
  let rows = await ready({ state, fetchTranscript: async () => ({ data: [] }) });
  assert.equal(rows[0].status, 'pending'); assert.equal(state.pending.m1.attempts, 1); assert.deepEqual(state.processed, {});
  rows = await ready({ state, fetchTranscript: async () => { throw Error('secret must not appear'); } });
  assert.equal(rows[0].status, 'pending'); assert.equal(state.pending.m1.attempts, 2); assert.doesNotMatch(JSON.stringify(state), /secret/);
  rows = await ready({ state, now: now + 48 * 3600000, fetchTranscript: async () => ({ data: [] }) });
  assert.equal(rows[0].status, 'gave-up'); assert.ok(state.skipped.m1); assert.equal(state.pending.m1, undefined);
});
test('transcriptが準備できればpending解除、メモ失敗でもready', async () => {
  const state = { pending: { m1: { firstSeen: new Date(now).toISOString(), attempts: 2 } } };
  const rows = await ready({ state, fetchNotes: async () => { throw Error('private'); } });
  assert.equal(rows[0].status, 'ready'); assert.equal(state.pending.m1, undefined); assert.match(rows[0].reason, /メモ取得失敗/);
});
test('振分優先順位、実PC名・担当PCが未解決なら代行せず保留', () => {
  for (const [name, kind, label] of [['学会協賛', 'gakkai', 'w018-PC'], ['展示会ブース', 'booth', 'DELL'],
    ['営業自動化', 'production', '作業用011'], ['学会制作の自動化', 'production', '作業用011'], ['イベント式典', 'other', '008XPS8300']]) {
    const result = classifyFollowup({ meeting: meeting({ name }), caseMatch: {}, config });
    assert.equal(result.kind, kind); assert.equal(routeFollowup(kind, config, pcMap).pc.label, label);
  }
  const without014 = { ...pcMap }; delete without014.DELL;
  const held = routeFollowup('booth', config, without014);
  assert.equal(held.pc, null); assert.equal(held.requested, '作業用014');
  assert.match(held.note, /担当外PCでは代行しない/);
  assert.equal(routeFollowup('gakkai', config, {}).pc, null);
  assert.equal(routeFollowup('unknown', config, pcMap).pc, null);
  assert.equal(routeFollowup('booth', config, without014, [{ label: 'beacon014', remoteName: '作業用014' }]).pc.label, 'beacon014');
  assert.equal(classifyFollowup({ meeting: meeting({ name: '相談' }), caseMatch: { case: { name: '確認案件' } }, config }).kind, 'other');
});
test('案件無し・キーワード無しは011、マスター読取失敗だけheld', async () => {
  const state = {}; const rows = await ready({ meetings: [meeting({ name: '相談' })], cases: [], state });
  assert.equal(rows[0].kind, 'production'); assert.equal(rows[0].requestedPc, '作業用011'); assert.equal(rows[0].status, 'ready');
  assert.match(rows[0].reason, /案件・種別未特定のため011へ/);
  const failed = {}; const held = await ready({ config: { ...config, casesError: '案件一覧読取失敗・要確認' }, state: failed });
  assert.equal(held[0].status, 'held'); assert.ok(failed.held.m1);
  assert.match(held[0].reason, /案件一覧読取失敗・要確認/);
});
test('複数候補はタイトルとドメインで1件に絞り、Reブースは014へ', async () => {
  const booth = { id: 'C-booth', name: 'デージーネット Reブース', client: '株式会社デージーネット', phase: 'ブース制作', email: 'sales@example.com' };
  const other = { id: 'C-other', name: 'デージーネット 別件', client: '株式会社デージーネット', phase: '相談', email: 'other@example.net' };
  const event = { summary: 'M: 株式会社 デージーネット様(Reブース)', attendees: [{ email: 'sales@example.com' }] };
  const picked = resolveFollowupCase({ ...event }, [booth, other]);
  assert.equal(picked.case.id, 'C-booth');
  const rows = await ready({ meetings: [meeting({ name: 'M: 株式会社 デージーネット様(Reブース)' })], cases: [booth, other], events: [event] });
  assert.equal(rows[0].kind, 'booth'); assert.equal(rows[0].requestedPc, '作業用014'); assert.equal(rows[0].caseId, 'C-booth');
});
test('エイトは課題提供企業として008へ。対外新規連絡は出さない注意を付ける', async () => {
  const rows = await ready({ meetings: [meeting({ name: 'M:エイト様' })], cases: [] });
  assert.equal(rows[0].kind, 'other'); assert.equal(rows[0].customer, 'エイト');
  assert.equal(rows[0].requestedPc, '作業用008'); assert.equal(rows[0].pc.label, '008XPS8300');
  assert.match(rows[0].reason, /課題提供企業/);
  assert.match(rows[0].promptNote, /キャンセル済み/);
  assert.match(renderPrompt('{{specialInstructions}}', { specialInstructions: rows[0].promptNote }), /対外連絡/);
});
test('予定照合はメール > タイトル > 時刻。範囲外・キャンセル除外', () => {
  const event = (id, minute, extra = {}) => ({ id, summary: '別件', start: { dateTime: `2026-11-26T01:${minute}:00Z` }, ...extra });
  const nearest = event('time', '00'), title = event('title', '20', { summary: '展示会ブース' });
  const email = event('email', '29', { attendees: [{ email: 'GUEST@example.com' }] });
  assert.equal(matchCalendarEvent(meeting(), [nearest, title, email], { minutes: 30 }).id, 'email');
  assert.equal(matchCalendarEvent(meeting(), [nearest, title], { minutes: 30 }).id, 'title');
  assert.equal(matchCalendarEvent(meeting(), [nearest, event('later', '02')], { minutes: 30 }).id, 'time');
  assert.equal(matchCalendarEvent(meeting(), [event('outside', '31'), { ...nearest, status: 'cancelled' }], { minutes: 30 }), null);
});
test('顧客名の整形・空の扱い・案件client優先', () => {
  assert.equal(customerName({ caseMatch: { case: caseRow }, meeting: meeting() }), '顧客株式会社');
  assert.equal(customerName({ event: { summary: 'M：【確認】株式会社テスト様 打ち合わせ' } }), '株式会社テスト');
  assert.equal(customerName({ meeting: meeting({ name: 'M: 御中 打合せ' }) }), null);
  assert.equal(customerName({ meeting: meeting({ name: 'M: 株式会社 デージーネット様(Reブース)' }) }), '株式会社 デージーネット');
});
test('取引先ヒントは案件無しでも学会へ振り分ける', async () => {
  const rows = await ready({ meetings: [meeting({ name: 'M：ターゲットメディア大橋様' })], cases: [] });
  assert.equal(rows[0].kind, 'gakkai'); assert.equal(rows[0].customer, 'ターゲットメディア');
  assert.equal(rows[0].requestedPc, '作業用018'); assert.match(rows[0].reason, /取引先ヒント/);
});
test('案件無し・分類語無しは文字起こし冒頭の優勢語で推定する', async () => {
  const run = text => ready({ meetings: [meeting({ name: '定例相談' })], cases: [],
    fetchTranscript: async () => ({ data: [{ text }] }) });
  let rows = await run('学会 学会 学会 学会 ブース');
  assert.equal(rows[0].kind, 'gakkai'); assert.match(rows[0].reason, /文字起こし冒頭から推定（gakkai:4回）/);
  rows = await run('学会 学会 学会 ブース ブース');
  assert.equal(rows[0].kind, 'production'); assert.equal(rows[0].requestedPc, '作業用011');
  assert.match(rows[0].reason, /案件・種別未特定のため011へ/);
});
test('案件無しでもtranscript未準備ならheldではなくpending', async () => {
  const rows = await ready({ meetings: [meeting({ name: '定例相談' })], cases: [], fetchTranscript: async () => ({ data: [] }) });
  assert.equal(rows[0].status, 'pending');
});
test('excludedのレポートは種別・担当PC・実行先を表示しない', async () => {
  const rows = await ready({ meetings: [meeting({ name: '作業用008 採用面談' })] });
  const report = renderStatus(rows, { now, host: 'kim-PC' });
  assert.match(report, /\| — \| — \| — \| 対象外 \|/); assert.doesNotMatch(report, /種別未特定|008XPS8300/);
});
test('folderName: JST日付・Windows禁止文字除去・40文字制限', () => {
  assert.equal(folderName(meeting({ happenedAt: '2026-11-25T16:00:00Z' }), '顧客\\/:*?"<>|'), '20261126-顧客');
  assert.equal(folderName(meeting(), 'あ'.repeat(50)), '20261126-' + 'あ'.repeat(40));
});
test('promptの置換・切詰め注記・BOM保存', t => {
  const home = temp(t), file = path.join(home, 'prompt.txt');
  const text = renderPrompt('{{title}} {{transcript}} {{transcriptNote}} {{missing}}', { title: '会議', transcript: '123456789', maxTranscriptChars: 4 });
  assert.doesNotMatch(text, /\{\{/); assert.match(text, /1234/); assert.doesNotMatch(text, /12345/);
  assert.match(text, /先頭4文字のみ。全文は tl;dv MCP で取得/);
  writeBomUtf8(file, text); assert.deepEqual([...fs.readFileSync(file).subarray(0, 3)], [239, 187, 191]);
});
test('fleet-mail／directive成功後はprocessed保存し二重検知しない', async t => {
  const home = temp(t);
  for (const method of ['fleet-mail', 'fleet-directive']) {
    const state = {}, rows = await ready({ state }); let calls = 0;
    await dispatch({ results: rows, state, config, home, now, receivers: { DELL: receiver(method) }, send: async (batch, body) => {
      calls++; assert.equal(batch.method, method); assert.equal(batch.pc, 'DELL'); assert.match(body, /顧客株式会社/); assert.doesNotMatch(body, /\{\{/); return { id: 'mail-one' };
    }, runLocal: () => assert.fail('remoteのためlocal不要') });
    assert.equal(calls, 1); assert.equal(state.processed.m1.method, method); assert.equal(rows[0].status, 'dispatched');
    assert.deepEqual(await ready({ state }), []); assert.deepEqual(selectCandidates([meeting()], state, { now, config }).candidates, []);
  }
});
test('担当PC不明・経路なしはkim-PCで資料保存しローカル起動', async t => {
  const home = temp(t), state = {}, rows = await ready({ state, pcMap: {} }); let called = 0;
  await dispatch({ results: rows, state, config, home, now, send: () => assert.fail('他PCへ転送しない'), runLocal: async (batch, body) => {
    called++; assert.equal(batch.method, 'local'); assert.match(body, /kim-PC/); return { report: '見積下書き、外部更新未実行', drafts: [ledgerItem()] };
  } });
  assert.equal(called, 1); assert.equal(state.processed.m1.method, 'local');
  const folder = state.processed.m1.folder;
  assert.match(fs.readFileSync(path.join(folder, 'REPORT.md'), 'utf8'), /担当PC未解決/);
  assert.match(fs.readFileSync(path.join(folder, 'transcript.txt'), 'utf8'), /見積/);
  assert.equal(fs.readFileSync(path.join(folder, 'prompt.txt'), 'utf8').charCodeAt(0), 0xfeff);
  assert.ok(fs.existsSync(path.join(folder, 'meetings/m1/prompt.txt')));
});
test('起動前にclaimを保存し、応答消失・中断後は自動再送しない', async t => {
  const home = temp(t), state = {}, rows = await ready({ state }); let persisted;
  await dispatch({ results: rows, state, config, home, now, receivers: { DELL: receiver('fleet-mail') },
    checkpoint: () => { persisted = structuredClone(state); }, send: async () => {
      assert.equal(persisted.held.m1.status, 'held'); assert.match(persisted.held.m1.reason, /結果未確認/);
      assert.deepEqual(selectCandidates([meeting()], persisted, { now, config }).candidates, []);
      throw Error('response lost');
    } });
  assert.equal(state.processed.m1, undefined); assert.equal(rows[0].status, 'held');
  assert.deepEqual(await ready({ state: persisted }), []);
});
test('localExec=false・起動例外はprocessedにせず要確認', async t => {
  for (const enabled of [false, true]) {
    const home = temp(t), state = {}, rows = await ready({ state });
    await dispatch({ results: rows, state, config: { ...config, localExec: enabled }, home, now,
      runLocal: () => { if (!enabled) assert.fail('無効なので実行不可'); throw Error('secret-key'); } });
    assert.equal(rows[0].status, 'held'); assert.equal(state.processed.m1, undefined); assert.ok(state.held.m1);
    assert.doesNotMatch(JSON.stringify(state), /secret-key/);
  }
});
test('送信待ち台帳: 既存保持・重複排除・本文保存・match・原子的更新', t => {
  const home = temp(t), file = path.join(home, '.claude/unsent-ledger/ledger.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ custom: 42, items: [{ id: 'existing' }] }));
  const added = appendLedgerItems(file, [ledgerItem(), ledgerItem()], { now });
  assert.equal(added.length, 1); assert.equal(added[0].match.to, 'guest@example.com'); assert.equal(added[0].match.after, '2026-11-26T02:00:00.000Z');
  assert.equal(added[0].status, '未送信'); assert.equal(added[0].from, 'seisaku-team@orgiast.jp');
  assert.equal(fs.readFileSync(added[0].body_path, 'utf8'), ledgerItem().body);
  assert.deepEqual(appendLedgerItems(file, [ledgerItem()], { now }), []);
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(ledger.items.length, 2); assert.equal(ledger.custom, 42); assert.ok(ledger.generated_at);
  assert.ok(Object.keys(snapshot(home)).every(name => !name.endsWith('.tmp')));
  assert.ok(Object.keys(api).every(name => !/send.*(gmail|line)|(gmail|line).*send/i.test(name)));
});
test('fleet JSON下書きのみ回収・未処理会議除外・mail.id重複回避・連番', () => {
  const state = { processed: { m1: { endAt: ledgerItem().after } } };
  const mail = (id, extra = {}) => ({ id, body: JSON.stringify({ ...ledgerItem(), type: 'tldv-followup-draft', ...extra }) });
  const items = collectDraftReplies([mail('one'), mail('one'), mail('two'), mail('other', { meetingId: 'other' }), { id: 'bad', body: 'text' }], state);
  assert.deepEqual(items.map(item => item.id), ['tldv:m1:1', 'tldv:m1:2']);
  assert.deepEqual(collectDraftReplies([mail('one')], state), []); assert.ok(state.draftsSeen.one);
});
test('dry-run: dispatchはsend/runLocal・state変更なし、ledger書込なし', async t => {
  const home = temp(t), state = { processed: {} }, before = structuredClone(state);
  const rows = await ready();
  await dispatch({ results: rows, state, config, home, now, dryRun: true,
    send: () => assert.fail('dry send'), runLocal: () => assert.fail('dry local') });
  assert.equal(rows[0].status, 'planned'); assert.match(rows[0].reason, /起動予定:.*local/); assert.deepEqual(state, before);
  const planned = appendLedgerItems(path.join(home, '.claude/unsent-ledger/ledger.json'), [ledgerItem()], { dryRun: true, now });
  assert.equal(planned.length, 1); assert.deepEqual(snapshot(home), {});
});
test('main dry-run: 2アカウント読取・日付/ID絞込・既存全ファイル不変', async t => {
  const home = temp(t), output = temp(t), file = path.join(home, config.stateFile), users = [];
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{"processed":{}}');
  const before = snapshot(home);
  const code = await main(['--dry-run', '--date', '2026-11-26', '--meeting', 'm1', '--report-dir', output, '--lookback-hours', '80'], deps(home, {
    createGoogle: options => { users.push(options.user); return options; }, send: () => assert.fail('dry-run送信禁止'), runLocal: () => assert.fail('dry-run実行禁止') }));
  assert.equal(code, 0); assert.deepEqual(new Set(users), new Set(['kim@orgiast.jp', 'seisaku-team@orgiast.jp']));
  assert.deepEqual(snapshot(home), before);
  assert.match(fs.readFileSync(path.join(output, 'dry-run.md'), 'utf8'), /起動予定\(dry-run\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'dry-run.json'), 'utf8')).length, 1);
});
test('main: 正常実行→レポート・状態・返信台帳→再実行でも重複なし', async t => {
  const home = temp(t); let sends = 0;
  const injected = deps(home, { send: async () => { sends++; return { id: 'mail-ok' }; }, inspectFleet: async () => ({
    receivers: { DELL: receiver('fleet-mail') }, beacons: [], inbox: [{ id: 'reply1', body: JSON.stringify({ ...ledgerItem(), type: 'tldv-followup-draft' }) }] }) });
  assert.equal(await main([], injected), 0); assert.equal(await main([], injected), 0); assert.equal(sends, 1);
  const state = JSON.parse(fs.readFileSync(path.join(home, config.stateFile), 'utf8'));
  assert.equal(state.processed.m1.mailId, 'mail-ok'); assert.ok(state.draftsSeen.reply1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, config.ledgerFile), 'utf8')).items.length, 1);
  assert.equal(fs.readFileSync(path.join(home, config.jobStatusFile), 'utf8').trim().split('\n').length, 4);
  assert.equal(fs.existsSync(path.join(home, '.claude/state/tldv-followup-dispatch.lock')), false);
});
test('main: カレンダー失敗は理由付き継続・案件失敗は保留', async t => {
  for (const casesFail of [false, true]) {
    const home = temp(t); let sends = 0;
    assert.equal(await main([], deps(home, { loadEvents: async () => { throw Error('private'); },
      loadCasesWithRetry: async () => { if (casesFail) throw Error('private'); return [caseRow]; }, send: async () => { sends++; return { id: 'mail-one' }; } })), 0);
    assert.equal(sends, casesFail ? 0 : 1);
    const report = fs.readFileSync(path.join(home, config.statusFile), 'utf8');
    assert.match(report, /カレンダー読取失敗/); assert.doesNotMatch(report, /private/);
    if (casesFail) assert.match(report, /要判断=1/);
  }
});
test('main: tl;dv 401/403はキーを伏せSTATUSとexit 2。dry-runは通常出力先に書かない', async t => {
  for (const status of [401, 403]) {
    const home = temp(t), injected = deps(home, { client: { listMeetings: async () => { throw Error(`tldv-http-${status} SECRET`); } } });
    assert.equal(await main([], injected), 2);
    const report = fs.readFileSync(path.join(home, config.jobStatusFile), 'utf8');
    assert.match(report, /TLDV_API_KEY 失効または権限不足/); assert.doesNotMatch(report, /SECRET/);
    const before = snapshot(home); assert.equal(await main(['--dry-run'], injected), 2); assert.deepEqual(snapshot(home), before);
  }
});
test('main: transcript側403でも送信せずexit 2', async t => {
  const home = temp(t), injected = deps(home);
  injected.client.transcript = async () => { throw Error('tldv-http-403'); };
  injected.send = () => assert.fail('認証エラーで起動不可');
  assert.equal(await main([], injected), 2);
});
test('main: fresh lockは実行せず、30分超のlockを回収', async t => {
  const home = temp(t), lock = path.join(home, '.claude/state/tldv-followup-dispatch.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, '{}');
  fs.utimesSync(lock, new Date(now), new Date(now));
  assert.equal(await main([], deps(home, { client: { listMeetings: () => assert.fail('ロック中') } })), 0);
  fs.utimesSync(lock, new Date(now - 31 * 60000), new Date(now - 31 * 60000));
  assert.equal(await main([], deps(home)), 0); assert.equal(fs.existsSync(lock), false);
});
test('main: lookbackから消えたpendingも48h後に終了、heldは毎回表示', async t => {
  const home = temp(t), file = path.join(home, config.stateFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pending: { old: { firstSeen: new Date(now - 49 * 3600000).toISOString() } },
    held: { h1: { meetingId: 'h1', title: '顧客の相談', status: 'held', reason: '要確認' } } }));
  const injected = deps(home); injected.client.listMeetings = async () => [];
  assert.equal(await main([], injected), 0);
  const state = JSON.parse(fs.readFileSync(file, 'utf8')); assert.ok(state.skipped.old); assert.deepEqual(state.pending, {});
  assert.match(fs.readFileSync(path.join(home, config.statusFile), 'utf8'), /要判断=1/);
});
test('ローカルworker: 他AI固定・ツールなし・env隔離・出力を回収', async t => {
  const home = temp(t), folder = path.join(home, 'job'); fs.mkdirSync(folder);
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude/test.env'), 'TEST_FOLLOWUP_API_KEY=test-key');
  const provider = { provider: 'deepseek', base: 'https://openrouter.ai/api', defaultModel: 'deepseek/test', envFile: 'test.env', keyName: 'TEST_FOLLOWUP_API_KEY', billingProvider: 'openrouter' };
  const result = await executeLocalFollowup({ folder }, '指示', { home, provider, resolveExecutable: async () => ({ executable: 'C:\\fake\\claude.exe' }),
    run: async (command, args, options) => {
      assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(options.env.ANTHROPIC_BASE_URL, provider.base);
      assert.equal(options.env.ANTHROPIC_MODEL, provider.defaultModel); assert.match(options.prompt, /未実行と明記/);
      return JSON.stringify({ result: JSON.stringify({ report: '下書き', drafts: [] }) });
    } });
  assert.equal(result.report, '下書き');
  for (const forbidden of [{ ...provider, base: 'https://api.anthropic.com' }, { ...provider, defaultModel: 'anthropic/claude-test' }])
    await assert.rejects(executeLocalFollowup({ folder }, '', { home, provider: forbidden }), /利用禁止/);
});
test('status: 指定ヘッダー・日本語状態・人が読める顧客/案件', async () => {
  const rows = await ready(); rows[0].status = 'held';
  const report = renderStatus(rows, { now, host: 'kim-PC' });
  assert.ok(report.startsWith('# tldv-followup PC=kim-PC 2026-11-26 13:00 JST status=OK 要判断=1\n\n'));
  assert.match(report, /顧客株式会社 \/ 展示会ブース/); assert.match(report, /要確認/);
});
test('helpとCLI引数検証: 外部接続しない', async t => {
  const home = temp(t); let help = '';
  assert.equal(await main(['--help'], { home, out: text => { help = text; } }), 0); assert.match(help, /--dry-run/);
  for (const argv of [['--date', '2026-02-30'], ['--meeting'], ['--lookback-hours', '0'], ['--unknown'], ['--report-dir', 'x']])
    assert.equal(await main(argv, deps(home, { client: { listMeetings: () => assert.fail('引数検証より先に接続しない') } })), 1);
  assert.deepEqual(snapshot(home), {});
  assert.match(execFileSync(process.execPath, ['tools/tldv-followup-dispatch.mjs', '--help'], { cwd: root, encoding: 'utf8', windowsHide: true }), /使い方/);
});
test('登録スクリプトBOM・専用タスク・15分・NextRunTime・資料40行以内', () => {
  const bytes = fs.readFileSync(path.join(root, 'tools/register-tldv-followup-task.ps1'));
  assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  const text = bytes.toString('utf8'); assert.match(text, /New-HiddenScheduledTaskAction/); assert.match(text, /RepetitionInterval \(New-TimeSpan -Minutes 15\)/);
  assert.match(text, /-Force/); assert.match(text, /Get-ScheduledTaskInfo.*OrgiastTldvFollowupDispatch/); assert.match(text, /NextRunTime/);
  assert.ok(fs.readFileSync(path.join(root, 'docs/tldv-followup-dispatch.md'), 'utf8').trimEnd().split('\n').length <= 40);
});
