import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';
import { main as registerTasks } from './register-auto-progress-task.mjs';
import { isNoopPromise, extractPromise, extractNextKim, applyPromise, buildRecord, record, readLedger, ledgerFile, rowKey, originLine } from './auto-progress-ledger.mjs';
import { run as watch, parseVerdict, deterministicVerdict, judge, GRACE_MS, RESUME_INTERVAL_MS, MAX_RESUMES, postSheet, resumeSession, recentFiles, EXPIRE_UNATTENDED_MS, FALLBACK_STALL_MS, formatDoneMessage, readableReason } from './auto-progress-watch.mjs';
import { run as digest, selectRows, formatDigest, isUnattendedRow, WINDOW_MS, MAX_ITEMS, needsDm, verdictOf, cleanText } from './auto-progress-digest.mjs';
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';

const tempHomes = [];
const tmp = () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-progress-')); tempHomes.push(home); return home; };
after(() => { for (const home of tempHomes) fs.rmSync(home, { recursive: true, force: true }); });
const H = 3600000;

test('extractPromise: 半角/全角コロン・装飾に対応', () => {
  assert.equal(extractPromise('この後の自動進行: 夜間にPRをマージ'), '夜間にPRをマージ');
  assert.equal(extractPromise('この後の自動進行：夜間にPRをマージ'), '夜間にPRをマージ');
  assert.equal(extractPromise('- **この後の自動進行**: CIを待ってマージ\n- 次'), 'CIを待ってマージ');
});

test('extractPromise: なし/無し/ダッシュは記録しない', () => {
  for (const v of ['なし', '無し', 'なし。', '—', '-', '**なし**', 'なし（終了済み）', '無し(完了)' ]) assert.equal(extractPromise(`この後の自動進行: ${v}`), null, v);
  assert.equal(extractPromise('宣言なしの文章'), null);
});

test('extractNextKim', () => {
  assert.equal(extractNextKim('次に kim がすること: 特になし\nこの後の自動進行: x'), '特になし');
});

test('applyPromise: 同一 sessionId の open は superseded になり新行が open', () => {
  const old = { sessionId: 's1', ts: 'a', status: 'open' };
  const other = { sessionId: 's2', ts: 'a', status: 'open' };
  const done = { sessionId: 's1', ts: 'z', status: 'done' };
  const next = applyPromise([old, other, done], { sessionId: 's1', ts: 'b', status: 'open' });
  assert.equal(next[0].status, 'superseded');
  assert.equal(next[1].status, 'open');
  assert.equal(next[2].status, 'done');
  assert.equal(next[3].status, 'open');
});

test('record: hook 入力から台帳へ追記し、再記録で置換。なしは書かない', () => {
  const home = tmp();
  const input = { session_id: 'sess', cwd: '/w', transcript_path: '/t.jsonl', last_assistant_message: '次に kim がすること: なし\nこの後の自動進行: 明朝に再実行' };
  const row = record(input, { home, hostname: 'PC', user: 'u', now: Date.parse('2026-10-14T00:00:00Z') });
  assert.equal(row.promise, '明朝に再実行'); assert.equal(row.status, 'open'); assert.equal(row.pc, 'PC');
  record({ ...input, last_assistant_message: 'この後の自動進行: 別件' }, { home, hostname: 'PC', user: 'u', now: Date.parse('2026-10-14T01:00:00Z') });
  const rows = readLedger(ledgerFile(home));
  assert.deepEqual(rows.map((r) => r.status), ['superseded', 'open']);
  assert.equal(record({ ...input, last_assistant_message: 'この後の自動進行: なし' }, { home }), null);
  assert.equal(readLedger(ledgerFile(home)).length, 2);
});

test('buildRecord: sessionId が無ければ transcript 名から補う', () => {
  assert.equal(buildRecord({ transcript_path: '/a/abc.jsonl' }, 'この後の自動進行: x').sessionId, 'abc');
});

test('parseVerdict と決定論フォールバック', () => {
  assert.deepEqual(parseVerdict('stalled | 動きなし'), { verdict: 'stalled', reason: '動きなし' });
  assert.equal(parseVerdict('よく分かりません'), null);
  const now = Date.now();
  assert.equal(deterministicVerdict({ any: false }, now).verdict, 'stalled');
  assert.equal(deterministicVerdict({ any: true, lastEvidenceAt: now - H / 2 }, now).verdict, 'in_progress');
  assert.equal(deterministicVerdict({ any: true, lastEvidenceAt: now - FALLBACK_STALL_MS }, now).verdict, 'stalled');
});

test('judge: LLM 全滅(null/例外)なら決定論へ。証拠なしは LLM を呼ばない', () => {
  const now = Date.now();
  const ev = { any: true, lastEvidenceAt: now - 9 * H, transcript: { count: 1, lastAt: now - 9 * H, snippets: [] }, files: { names: [], lastAt: 0 }, runs: { names: [] } };
  const row = { promise: 'p', ts: new Date(now - 10 * H).toISOString() };
  assert.equal(judge(row, ev, now, { askLlm: () => null }).source, 'deterministic');
  assert.equal(judge(row, ev, now, { askLlm: () => { throw new Error('x'); } }).verdict, 'in_progress');
  assert.deepEqual(judge(row, { ...ev, transcript: { ...ev.transcript, snippets: ['完了しました'] } }, now, { askLlm: () => 'done | 完了' }), { verdict: 'done', reason: '完了', source: 'llm' });
  let called = false;
  judge(row, { ...ev, any: false }, now, { askLlm: () => { called = true; return 'done'; } });
  assert.equal(called, false);
});

function seed(home, rows) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(ledgerFile(home), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const baseIo = (extra = {}) => ({ sheetConfig: () => ({ url: 'u', token: 't' }), cwdExists: () => true, digest: async () => ({ sent: false, count: 0 }), notifyOwner: async () => ({ delivered: 'none', reason: 'mock' }), ...extra });
const evAny = (now) => ({ transcript: { count: 1, lastAt: now - 8 * H, snippets: [] }, files: { names: [], lastAt: 0 }, runs: { names: [] }, lastEvidenceAt: now - 8 * H, any: true });

test('watch: 猶予1時間未満は判定しない', async () => {
  const home = tmp(); const now = Date.now();
  seed(home, [{ sessionId: 's', ts: new Date(now - H / 2).toISOString(), status: 'open', promise: 'p', cwd: home, pc: 'PC' }]);
  const calls = [];
  const s = await watch({ home, now, io: baseIo({ gatherEvidence: undefined, transcriptEvidence: () => { calls.push(1); return { count: 0, lastAt: 0, snippets: [] }; } }) });
  assert.equal(s.graced, 1); assert.equal(s.checked, 0); assert.equal(calls.length, 0);
  assert.equal(GRACE_MS, H);
});

test('watch: APIエラー未返答を1回だけ起票してDMし、dry-runは数えるだけで書かない', async () => {
  const home = tmp(), transcript = path.join(home, 'session-api.jsonl');
  const errorAt = '2026-10-22T23:30:00.000Z';
  const found = { sessionId: 'session-api', cwd: home, transcriptPath: transcript, requestText: '秘密 token=abc を含む依頼', errorAt,
    error: 'rate_limit', apiError: 'model_requires_usage_credits', apiErrorStatus: 429 };
  let dm = 0;
  const io = { transcriptFiles: [transcript], findUnansweredRequest: () => found, localOwner: 'kim', sheetConfig: () => null,
    notifyOwner: async () => { dm++; return { delivered: 'dm' }; }, digest: async () => ({}) };
  const now = Date.parse('2026-10-23T00:00:00.000Z');
  const first = await watch({ home, now, io });
  assert.equal(first.discovered, 1); assert.equal(dm, 1);
  let rows = readLedger(ledgerFile(home));
  assert.equal(rows.length, 1); assert.equal(rows[0].source, 'api-error-unanswered'); assert.equal(rows[0].status, 'open');
  const second = await watch({ home, now, io });
  assert.equal(second.discovered, 0); assert.equal(dm, 1); assert.equal(readLedger(ledgerFile(home)).length, 1);

  const dryHome = tmp();
  const dry = await watch({ home: dryHome, now, dryRun: true, io });
  assert.equal(dry.discovered, 1); assert.equal(dm, 1); assert.equal(fs.existsSync(ledgerFile(dryHome)), false);
});

test('resumeSession: APIエラー未返答だけ別モデルを指定する', async () => {
  const home = tmp(), calls = [];
  const invoke = async row => resumeSession(row, { home, io: { executable: 'claude', runChild: async (...args) => {
    calls.push(args);
    const resultFile = path.join(home, '.claude', `auto-progress-resume-${row.sessionId.slice(0, 8)}.json`);
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify({ state: 'done', evidence: '完了' }));
    return { status: 'success' };
  } } });
  await invoke({ sessionId: 'api-error-session', cwd: home, transcriptPath: '/t', source: 'api-error-unanswered', requestText: '依頼', promise: '依頼', error: 'rate_limit', apiErrorStatus: 429 });
  await invoke({ sessionId: 'normal-session', cwd: home, transcriptPath: '/t', promise: '通常の宣言' });
  assert.equal(calls[0][5].model, process.env.AUTO_PROGRESS_RESUME_MODEL || 'opus');
  assert.equal('model' in calls[1][5], false);
  assert.match(calls[0][1], /最初から通常どおり応えてください/);
});

test('watch: done は閉じ、stalled は再開1回＋Sheet報告、同日2回目は再開しない', async () => {
  // 実時刻の23時台では now + H が翌日になり、再開が正しく許可される。
  // localDay と同じローカル時刻の正午に固定して、どのTZでも同日を検証する。
  const home = tmp(); const now = new Date(2026, 9, 15, 12).getTime();
  const mk = (id) => ({ sessionId: id, ts: new Date(now - 10 * H).toISOString(), status: 'open', promise: `p-${id}`, cwd: home, pc: 'PC', user: 'u', transcriptPath: '' });
  seed(home, [mk('a'), mk('b')]);
  const posts = []; const resumed = [];
  const io = baseIo({
    transcriptEvidence: () => ({ count: 1, lastAt: now - 8 * H, snippets: ['完了しました'] }), recentFiles: () => ({ lastAt: 0, names: [] }), autoSessionRuns: () => ({ lastAt: 0, names: [] }),
    askLlm: (prompt) => (prompt.includes('p-a') ? 'done | 完了' : 'stalled | 止まっている'),
    resume: async (row) => { resumed.push(row.sessionId); return { outcome: 'progressed', reason: 'ok' }; },
    postSheet: async (_c, kind, body) => { posts.push({ kind, body }); return { ok: true }; },
  });
  const s = await watch({ home, now, io });
  assert.equal(s.done, 1); assert.equal(s.stalled, 1); assert.equal(s.resumed, 1); assert.equal(s.reported, 1);
  assert.deepEqual(resumed, ['b']);
  assert.equal(posts[0].kind, 'auto-progress');
  assert.equal(posts[0].body.row.sessionId, 'b'); assert.equal(posts[0].body.row.resumeAttempted, true); assert.equal(posts[0].body.row.verdict, 'stalled');
  const rows = readLedger(ledgerFile(home));
  assert.equal(rows.find((r) => r.sessionId === 'a').status, 'done');
  assert.equal(rows.find((r) => r.sessionId === 'b').status, 'resumed');
  const s2 = await watch({ home, now: now + H, io });
  assert.equal(s2.resumed, 0); assert.equal(s2.reported, 0); assert.equal(resumed.length, 1);
});

test('watch: needs_user/done 遷移、1h grace・2h resume・上限8', async () => {
  assert.equal(GRACE_MS, H); assert.equal(RESUME_INTERVAL_MS, 2 * H); assert.equal(MAX_RESUMES, 8);
  const now = Date.parse('2026-10-19T12:00:00Z');
  for (const [state, expected] of [['needs_user', 'waiting_user'], ['done', 'done']]) {
    const home = tmp(); seed(home, [{ sessionId: state, owner: 'cr@orgiast.jp', nextKim: '送信承認', ts: new Date(now - 3 * H).toISOString(), status: 'open', promise: state, cwd: home, pc: 'PC' }]);
    const notices = [];
    await watch({ home, now, io: noEvidenceIo({ resume: async () => ({ outcome: state, state, reason: '成果', artifact: 'out.txt' }), notifyOwner: async (...args) => { notices.push(args); return { delivered: 'dm' }; } }) });
    assert.equal(readLedger(ledgerFile(home))[0].status, expected);
    if (state === 'needs_user') assert.equal(notices.length, 1);
  }
});

test('recentFiles: cwd の他session更新は証拠にせず transcript 指定パスだけを見る', () => {
  const home = tmp(), foreign = path.join(home, 'foreign.txt'), own = path.join(home, 'own.txt');
  fs.writeFileSync(foreign, 'x'); fs.writeFileSync(own, 'x');
  assert.deepEqual(recentFiles(home, 0, { paths: [] }).names, []);
  assert.deepEqual(recentFiles(home, 0, { paths: [own] }).names, [own]);
});

test('watch: Sheet 失敗は errors に残り、次回再送できる', async () => {
  const home = tmp(); const now = Date.now();
  seed(home, [{ sessionId: 'c', ts: new Date(now - 10 * H).toISOString(), status: 'open', promise: 'p', cwd: home, pc: 'PC' }]);
  let fail = true;
  const io = baseIo({ transcriptEvidence: () => ({ count: 0, lastAt: 0, snippets: [] }), recentFiles: () => ({ lastAt: 0, names: [] }), autoSessionRuns: () => ({ lastAt: 0, names: [] }),
    resume: async () => ({ outcome: 'no-progress', reason: 'r' }), postSheet: async () => { if (fail) throw new Error('boom'); return { ok: true }; } });
  const s = await watch({ home, now, io });
  assert.equal(s.errors.length, 1); assert.equal(s.reported, 0);
  fail = false;
  const s2 = await watch({ home, now: now + 24 * H, io });
  assert.equal(s2.reported, 1);
});

test('digest: 非kim-PCも自PC台帳の進捗を送り、0件なら送らない', async () => {
  const now = Date.parse('2026-10-15T09:00:00+09:00');
  const rows = [
    { sessionId: 'k1', pc: 'other-PC', nextKim: '公開を確認', promise: '夜間デプロイ', ts: new Date(now - 30 * H).toISOString(), lastCheckedAt: new Date(now - H).toISOString(), status: 'open' },
  ];
  assert.equal(selectRows(rows, now).length, 1);
  const text = formatDigest(selectRows(rows, now), now, 'other-PC');
  assert.match(text, /^【other-PC の自動進行】 完了 0件・止まっている 0件・あなたの判断待ち 1件/);
  assert.match(text, /あなたの判断待ち: 夜間デプロイ — 公開を確認/);
  const sent = [];
  const io = { label: 'other-PC', readLedger: () => rows, readState: () => ({}), writeState: () => {}, appendFileSync: () => {}, mkdirSync: () => {}, notify: async (t) => { sent.push(t); return { delivered: 'dm' }; } };
  assert.deepEqual(await digest({ home: tmp(), now, slot: '朝', io }), { sent: true, count: 1, parts: 1 });
  assert.equal(sent.length, 1);
  assert.deepEqual(await digest({ home: tmp(), now, slot: '朝', io: { ...io, readLedger: () => [] } }), { sent: false, count: 0 });
  assert.equal(sent.length, 1);
});

test('digest: 同一スロット・同一内容を二重送信せず、doneは前回成功以降だけ含む', async () => {
  const now = Date.parse('2026-10-15T09:05:00+09:00');
  const recent = { status: 'done', promise: 'recent', ts: new Date(now - 10 * H).toISOString(), doneAt: new Date(now - H).toISOString() };
  const old = { status: 'done', promise: 'old', ts: new Date(now - 20 * H).toISOString(), doneAt: new Date(now - 5 * H).toISOString() };
  let saved;
  const io = { label: 'cr-PC', readLedger: () => [old, recent], readState: () => saved || { lastSuccessAt: new Date(now - 2 * H).toISOString() }, writeState: (_h, value) => { saved = value; }, appendFileSync: () => {}, mkdirSync: () => {}, notify: async () => ({ delivered: 'dm' }) };
  assert.deepEqual(await digest({ home: tmp(), now, slot: '朝', io }), { sent: true, count: 1, parts: 1 });
  assert.deepEqual(await digest({ home: tmp(), now, slot: '朝', io }), { skipped: 'already-sent', sent: false, count: 0 });
});

test('watch: summaryログがEBUSYでも巡回結果を返す', async () => {
  const home = tmp(); const errors = [];
  const result = await watch({ home, now: Date.now(), io: { ...baseIo(), appendFileSync: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }, stderr: (line) => errors.push(line) } });
  assert.equal(result.checked, 0);
  assert.match(errors.join('\n'), /summary log failed: locked/);
});

test('runRegisterPs1: win32 以外は何もせず、win32 では powershell -File で .ps1 を呼ぶ', () => {
  assert.equal(runRegisterPs1('register-auto-progress-task.ps1', { platform: 'linux', spawnImpl: () => { throw new Error('no'); } }), 0);
  let args;
  const log = console.log; console.log = () => {};
  try { runRegisterPs1('register-auto-progress-task.ps1', { platform: 'win32', spawnImpl: (cmd, a) => { args = [cmd, a]; return { status: 0, stdout: 'ok' }; } }); } finally { console.log = log; }
  assert.equal(args[0], 'powershell.exe'); assert.ok(args[1].at(-1).endsWith('register-auto-progress-task.ps1'));
  assert.throws(() => runRegisterPs1('x.ps1', { platform: 'win32', spawnImpl: () => ({ status: 1, stderr: 'bad' }) }), /bad/);
});

const noEvidenceIo = extra => baseIo({
  transcriptEvidence: () => ({ count: 0, lastAt: 0, snippets: [] }),
  recentFiles: () => ({ lastAt: 0, names: [] }),
  autoSessionRuns: () => ({ lastAt: 0, names: [] }),
  postSheet: async () => ({ ok: true, updated: true }), ...extra,
});

test('watch: 再開前に試行を保存し、再開中の新しい宣言を復活させない', async () => {
  const home = tmp(), now = Date.parse('2026-10-15T12:00:00Z');
  seed(home, [{ sessionId: 's', ts: new Date(now - 10 * H).toISOString(), status: 'open', promise: 'old', cwd: home, pc: 'PC', user: 'u' }]);
  const io = noEvidenceIo({ resume: async () => {
    const attempt = readLedger(ledgerFile(home))[0];
    assert.equal(attempt.resumeCount, 1);
    assert.equal(attempt.resumedAt, new Date(now).toISOString());
    record({ session_id: 's', cwd: home, last_assistant_message: 'この後の自動進行: new' }, { home, now, hostname: 'PC', user: 'u' });
    return { outcome: 'progressed', reason: 'new promise' };
  } });
  await watch({ home, now, io });
  assert.deepEqual(readLedger(ledgerFile(home)).map(r => r.status), ['superseded', 'open']);
  assert.equal((await watch({ home, now, io })).resumed, 0);
});

test('postSheet: token/kind 経路と未適用GAS・非JSON・HTTP失敗を検証', async () => {
  const config = { url: 'https://sheet.invalid', token: 'test-token' };
  const fetchImpl = async (url, options) => {
    assert.equal(url, config.url);
    assert.deepEqual(JSON.parse(options.body), { token: config.token, kind: 'auto-progress', row: { key: 'k' } });
    return { ok: true, text: async () => JSON.stringify({ ok: true, updated: false }) };
  };
  assert.deepEqual(await postSheet(config, 'auto-progress', { row: { key: 'k' } }, { fetchImpl }), { ok: true, updated: false });
  for (const body of ['<html>login</html>', '{"ok":false,"error":"unauthorized"}', '{"ok":true,"action":"updated"}']) {
    await assert.rejects(postSheet(config, 'auto-progress', {}, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => body }) }));
  }
});

test('digest: DM未達を成功にせず、公開webhookへ送らない', async () => {
  const now = Date.now();
  const result = await digest({ home: tmp(), slot: '朝', now, io: {
    label: 'kim-PC', readState: () => ({}), appendFileSync: () => {}, mkdirSync: () => {},
    readLedger: () => [{ status: 'resumed', nextKim: '確認', promise: 'p', ts: new Date(now - H).toISOString(), resumedAt: new Date(now).toISOString() }],
    notify: async (_text, options) => { assert.equal(options.webhookFallback, false); return { delivered: 'none', reason: 'failed' }; },
  } });
  assert.equal(result.sent, false);
  assert.equal(result.error, 'failed');
});

test('resumeSession: 古い成果JSONは再利用しない', async () => {
  const home = tmp(); fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'auto-progress-resume-session.json'), '{"progressed":true,"evidence":"old"}');
  const result = await resumeSession({ sessionId: 'session', cwd: home, promise: 'p' }, { home, io: { executable: 'mock', runChild: async () => ({ status: 'success' }) } });
  assert.equal(result.outcome, 'blocked');
});

test('buildRecord: hostname と OS username の既定値を記録', () => {
  const row = buildRecord({ session_id: 's' }, 'この後の自動進行: p');
  assert.equal(row.pc, os.hostname());
  assert.equal(row.user, os.userInfo().username);
});

test('registerTasks: 両タスクを共通scheduled-task APIでread-backし、欠落は失敗', async () => {
  const names = [];
  const opts = { platform: 'win32', spawnImpl: () => ({ status: 0, stdout: '' }), getTaskInfo: async name => { names.push(name); return { taskName: name }; } };
  await registerTasks(opts);
  assert.deepEqual(names, ['OrgiastAutoProgressWatch', 'OrgiastAutoProgressDigest']);
  await assert.rejects(registerTasks({ ...opts, getTaskInfo: async () => null }), /read-back failed/);
});

test('GAS追加案: 同一keyは更新、別PCは別行、24h抽出と再開フラグを保持', () => {
  const data = []; let locked = false;
  const sheet = {
    getLastRow: () => data.length, setFrozenRows() {},
    appendRow: values => data.push(values),
    getRange: (r, c, n = 1, width) => ({
      setNumberFormat() {},
      setValues: values => values.forEach((v, i) => { data[r - 1 + i] = v; }),
      getValues: () => data.slice(r - 1, r - 1 + n).map(v => v.slice(c - 1, c - 1 + width)),
    }),
  };
  let created = false;
  const context = vm.createContext({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => created ? sheet : null, insertSheet: () => { created = true; return sheet; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'mock-id' }) },
    LockService: { getScriptLock: () => ({ waitLock: () => { assert.equal(locked, false); locked = true; }, releaseLock: () => { locked = false; } }) },
  });
  vm.runInContext(fs.readFileSync(new URL('../docs/auto-progress-gas-patch.gs.txt', import.meta.url), 'utf8'), context);
  const row = { key: 'PC|u|s|t', pc: 'PC', promise: 'p', reportedAt: '2026-10-15T00:00:00Z', resumeAttempted: true };
  assert.equal(context.upsertAutoProgress({ row }).updated, false);
  assert.equal(context.upsertAutoProgress({ row: { ...row, promise: 'updated' } }).updated, true);
  context.upsertAutoProgress({ row: { ...row, key: 'OTHER|u|s|t', pc: 'OTHER', reportedAt: '2026-10-10T00:00:00Z' } });
  const result = context.listAutoProgress({ sinceMs: Date.parse('2026-10-14T00:00:00Z') });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].promise, 'updated');
  assert.equal(result.rows[0].resumeAttempted, true);
  assert.equal(data.length, 3);
  assert.equal(locked, false);
});

test('readLedger: 壊れたJSONとnull/配列を無視して有効行を処理する', () => {
  const home = tmp(), file = ledgerFile(home);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'null\n[]\nbroken\n{"sessionId":"s","status":"open"}\n');
  assert.deepEqual(readLedger(file), [{ sessionId: 's', status: 'open' }]);
});

test('watch: 同一sessionの最新だけを選び、旧open/stalled/resumedを保存時にsupersededにする', async () => {
  const home = tmp(), now = Date.parse('2026-10-17T12:00:00Z');
  const mk = (hours, status) => ({ sessionId: 'same', ts: new Date(now - hours * H).toISOString(), status, cwd: home });
  const rows = [mk(12, 'open'), mk(40, 'stalled'), mk(20, 'resumed'), { ...mk(60, 'done'), sessionId: 'done' }];
  seed(home, rows);
  const resumed = [];
  const io = noEvidenceIo({ resume: async row => { resumed.push(row.ts); return { outcome: 'progressed', reason: 'ok' }; } });
  const preview = await watch({ home, now, dryRun: true, io });
  assert.equal(preview.superseded, 2);
  assert.deepEqual(readLedger(ledgerFile(home)), rows);
  const result = await watch({ home, now, io });
  assert.equal(result.superseded, 2);
  assert.deepEqual(resumed, [rows[0].ts]);
  assert.deepEqual(readLedger(ledgerFile(home)).map(r => r.status), ['resumed', 'superseded', 'superseded', 'done']);
  assert.equal(applyPromise([mk(40, 'stalled')], mk(1, 'open'))[0].status, 'superseded');
});

test('watch: 最新宣言が猶予中なら同sessionの古い約束を再開しない', async () => {
  const home = tmp(), now = Date.parse('2026-10-17T12:00:00Z');
  seed(home, [10, 0.5].map(hours => ({ sessionId: 's', ts: new Date(now - hours * H).toISOString(), status: 'open', cwd: home })));
  const result = await watch({ home, now, io: noEvidenceIo({ resume: async () => assert.fail('must not resume') }) });
  assert.equal(result.checked, 0);
  assert.equal(result.graced, 1);
  assert.deepEqual(readLedger(ledgerFile(home)).map(r => r.status), ['superseded', 'open']);
});

test('watch: nextKimが空/なしを優先して古い順に最大4件を再開', async () => {
  const home = tmp(), now = Date.parse('2026-10-17T12:00:00Z');
  const specs = [['waiting-old', 60, '確認'], ['direct-new', 10, 'なし'], ['direct-old', 30, ''], ['waiting-new', 50, '返信'], ['direct-mid', 20, undefined]];
  seed(home, specs.map(([sessionId, age, nextKim]) => ({ sessionId, ts: new Date(now - age * H).toISOString(), nextKim, status: 'stalled', cwd: home })));
  const resumed = [];
  const result = await watch({ home, now, io: noEvidenceIo({ resume: async row => { resumed.push(row.sessionId); return { outcome: 'progressed', reason: 'ok' }; } }) });
  assert.equal(result.resumed, 4);
  assert.deepEqual(resumed, ['direct-old', 'direct-mid', 'direct-new', 'waiting-old']);
});

test('digest: 大量の完了も一通に集約し上位以外を次回へ分割しない', async () => {
  const now = Date.now(), home = tmp();
  const rows = Array.from({ length: MAX_ITEMS + 2 }, (_, i) => ({ sessionId: `s${i}`, status: 'done', promise: `作業${i}`, ts: new Date(now - WINDOW_MS).toISOString(), doneAt: new Date(now - H).toISOString() }));
  const messages = [];
  const io = { readLedger: () => rows, notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  const first = await digest({ home, slot: '朝', now, io });
  assert.equal(first.count, MAX_ITEMS + 2);
  assert.match(messages[0], /完了 12/);
  assert.ok(messages[0].split('\n').length <= 10);
  assert.equal((await digest({ home, slot: '朝', now: now + WINDOW_MS, io })).count, 0);
  assert.deepEqual(await digest({ home, slot: '朝', now: now + WINDOW_MS * 2, io }), { sent: false, count: 0 });
  assert.ok(messages.every(message => message.length <= 2000));
});

test('schedule: watchは毎時・実行上限55分とし既存PCも更新する', () => {
  const script = fs.readFileSync(new URL('./register-auto-progress-task.ps1', import.meta.url), 'utf8');
  const triggers = script.match(/\$watchTriggers = (.*)/)[1];
  assert.deepEqual([...triggers.matchAll(/-At '([^']+)'/g)].map(m => m[1]), ['00:00']);
  assert.match(triggers, /New-TimeSpan -Hours 1/);
  assert.match(script, /-ExecutionTimeLimit \(New-TimeSpan -Minutes 55\)/);
  const poller = fs.readFileSync(new URL('./fleet-poller.ps1', import.meta.url), 'utf8');
  assert.match(poller, /if \(\$Dry\) \{ DrySkip 'register-auto-progress-task.ps1/);
  assert.match(poller, /-File \$autoProgressInstaller/);
  const installer = fs.readFileSync(new URL('./install-orgiast.ps1', import.meta.url), 'utf8');
  assert.match(installer, /-File \$autoProgressInstaller/);
});


test('watch: 同一session・同一時刻の重複でも最後の行だけ再開対象として残す', async () => {
  const home = tmp(), now = Date.parse('2026-10-17T12:00:00Z');
  const row = { sessionId: 's', ts: new Date(now - 10 * H).toISOString(), status: 'open', cwd: home };
  seed(home, [{ ...row, promise: 'old' }, { ...row, promise: 'latest' }]);
  const resumed = [];
  const result = await watch({ home, now, io: noEvidenceIo({ resume: async r => { resumed.push(r.promise); return { outcome: 'progressed', reason: 'ok' }; } }) });
  assert.equal(result.superseded, 1);
  assert.deepEqual(resumed, ['latest']);
  assert.deepEqual(readLedger(ledgerFile(home)).map(r => r.status), ['superseded', 'resumed']);
});


test('digest routes each promise only to its owner', async () => {
  const now = Date.now(), calls = [];
  const rows = ['a', 'b'].map(owner => ({ owner, sessionId: `session-${owner}`, status: 'waiting_user', nextKim: '送信承認', promise: owner === 'a' ? '資料の確認' : '見積の確認', ts: new Date(now - H).toISOString() }));
  const result = await digest({ home: tmp(), now, io: {
    label: 'PC', readLedger: () => rows, readState: () => ({}), writeState() {},
    notifyOwner: async (owner, text) => { calls.push({ owner, text }); return { delivered: 'dm' }; },
  } });
  assert.equal(result.sent, true);
  assert.deepEqual(calls.map(c => c.owner), ['a', 'b']);
  assert.match(calls[0].text, /資料の確認/); assert.doesNotMatch(calls[0].text, /見積の確認/);
  assert.match(calls[1].text, /見積の確認/); assert.doesNotMatch(calls[1].text, /資料の確認/);
});

test('digest: owner 未記録の行は自PCの持ち主へ送り、owner 空で notifyOwner を呼ばない', async () => {
  const now = Date.now(), calls = [];
  const rows = [
    { sessionId: 'legacy-1', status: 'waiting_user', nextKim: '送信承認', promise: '旧台帳の約束', ts: new Date(now - H).toISOString() },
    { owner: 'b@example.com', sessionId: 'session-b', status: 'waiting_user', nextKim: '送信承認', promise: '見積の確認', ts: new Date(now - H).toISOString() },
  ];
  const result = await digest({ home: tmp(), now, io: {
    label: 'PC', readLedger: () => rows, readState: () => ({}), writeState() {}, localOwner: 'kim@example.com',
    notifyOwner: async (owner, text) => { calls.push({ owner, text }); return { delivered: 'dm' }; },
  } });
  assert.equal(result.sent, true);
  assert.deepEqual(calls.map(c => c.owner).sort(), ['b@example.com', 'kim@example.com']);
  assert.ok(calls.every(c => c.owner), 'owner 空で notifyOwner を呼んではいけない（本文に「宛先: 不明（DM 未解決）」が付く）');
  assert.match(calls.find(c => c.owner === 'kim@example.com').text, /旧台帳の約束/);
});

test('watch retries undelivered needs_user notification without waiting 24 hours', async () => {
  const home = tmp(), now = Date.now(); let attempts = 0;
  seed(home, [{ sessionId: 'waiting', owner: 'a', nextKim: '送信承認', status: 'open', promise: 'p', cwd: home, ts: new Date(now - 3 * H).toISOString() }]);
  const io = noEvidenceIo({
    resume: async () => ({ state: 'needs_user', reason: 'approval' }),
    notifyOwner: async () => { attempts++; return attempts === 1 ? { delivered: 'none' } : { delivered: 'dm' }; },
  });
  const first = await watch({ home, now, io });
  assert.equal(first.errors.length, 1);
  assert.equal(readLedger(ledgerFile(home))[0].ownerNotifiedAt, undefined);
  await watch({ home, now: now + H, io });
  assert.equal(attempts, 2);
  assert.equal(readLedger(ledgerFile(home))[0].ownerNotifiedAt, new Date(now + H).toISOString());
  await watch({ home, now: now + 2 * H, io });
  assert.equal(attempts, 2);
});

test('digest: 無人処理は数だけ、なし系を正規化し、埋め込まれた識別子も本文に出さない', async () => {
  const home = tmp(), now = Date.parse('2026-10-15T09:00:00+09:00');
  const row = { pc: 'DESKTOP-2D0R4LI', sessionId: 'abcdef12', status: 'done', doneAt: new Date(now).toISOString(), ts: new Date(now - H).toISOString(), nextKim: 'なし（確認済み）', promise: 'DESKTOP-2D0R4LI の abcdef12 を 2026-10-20T01:02:03Z に確認', reason: '確認完了' };
  const unattended = { ...row, sessionId: 'batch', cwd: path.join(home, '.claude', 'scratch', 'test'), promise: '表示しない約束' };
  const result = await digest({ home, now, slot: '朝', dryRun: true, io: { label: 'kim-PC', readLedger: () => [row, unattended], readState: () => ({}) } });
  assert.equal(result.count, 1);
  assert.match(result.text, /^【kim-PC(・[^】]*)? の自動進行】/);
  assert.match(result.text, /無人処理: 1件/);
  assert.match(result.text, /完了 1件/);
  assert.match(result.text, /・完了: の を 2026-10-20T01:02:03Z に確認/);
  assert.doesNotMatch(result.text, /DESKTOP-|abcdef12|表示しない約束/);
  assert.doesNotMatch(result.text.split('\n').filter(line => !line.startsWith('・')).join('\n'), /2026-10-|DESKTOP-|abcdef12/);
  assert.deepEqual(await digest({ home, now, slot: '朝', dryRun: true, io: { readLedger: () => [unattended], readState: () => ({}) } }), { sent: false, count: 0 });
});

test('isUnattendedRow: WindowsとPOSIX、境界を区別', () => {
  for (const home of ['C:\\Users\\kim', '/home/kim']) {
    for (const dir of ['nightly-repo', 'auto-session', 'scratch']) {
      for (const suffix of ['', '/sub']) assert.equal(isUnattendedRow({ cwd: `${home}/.claude/${dir}${suffix}` }, home), true);
      assert.equal(isUnattendedRow({ cwd: `${home}/.claude/${dir}-other` }, home), false);
    }
    assert.equal(isUnattendedRow({ cwd: `${home}/work/.stall-sweeper/task` }, home), true);
  }
  assert.equal(isUnattendedRow({ cwd: 'C:\\Users\\kim\\.claude\\scratch\\task' }, '/mnt/c/Users/kim'), true);
});

test('watch: 無人行は再開もDMもしない、48時間で判断待ちも期限切れ、Sheetは維持', async () => {
  const home = tmp(), now = Date.now();
  const rows = ['stalled', 'waiting_user'].flatMap(status => [H * 2, EXPIRE_UNATTENDED_MS].map(age => ({ status, sessionId: `${status}${age}`, ts: new Date(now - age).toISOString(), cwd: path.join(home, '.claude', 'nightly-repo') })));
  seed(home, rows);
  let posts = 0;
  const result = await watch({ home, now, io: noEvidenceIo({ resume: () => assert.fail('must not resume'), notifyOwner: () => assert.fail('must not notify'), postSheet: async () => { posts++; return { ok: true }; } }) });
  assert.equal(result.resumed, 0); assert.equal(result.expired, 2); assert.equal(posts, 1);
});

test('watch: 判定AI全滅でも24時間以内の動きを一斉stalledにせず再開しない', async () => {
  const home = tmp(), now = Date.now();
  seed(home, Array.from({ length: MAX_RESUMES }, (_, i) => ({ sessionId: `s${i}`, status: 'open', ts: new Date(now - FALLBACK_STALL_MS).toISOString(), cwd: home })));
  const result = await watch({ home, now, io: baseIo({ transcriptEvidence: () => ({ count: 1, lastAt: now - FALLBACK_STALL_MS / 2, snippets: [] }), recentFiles: () => ({ lastAt: 0, names: [] }), autoSessionRuns: () => ({ lastAt: 0, names: [] }), askLlm: () => null, resume: () => assert.fail('must not resume') }) });
  assert.equal(result.inProgress, MAX_RESUMES); assert.equal(result.stalled, 0); assert.equal(result.resumed, 0);
  assert.ok(readLedger(ledgerFile(home)).every(row => row.reason === '判定AIが使えず様子見'));
});

test('digest: 同じ判定は再送せず、判断依頼の追加と判定変化だけを次の枠で送る', async () => {
  const home = tmp(), now = Date.parse('2026-10-15T09:00:00+09:00');
  // 新規に止まった行（＝変化）で朝枠1通。
  let row = { sessionId: 's', ts: new Date(now - H).toISOString(), status: 'stalled', resumeCount: MAX_RESUMES, promise: '資料確認' };
  const io = { readLedger: () => [row], notify: async () => ({ delivered: 'dm' }) };
  assert.equal((await digest({ home, now, slot: '朝', io })).sent, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'state', 'auto-progress-digest.json'), 'utf8')).lastVerdicts[rowKey(row)], 'stalled');
  // 同じ朝枠の2回目は、内容が変わっても送らない（枠は1通まで）。
  assert.equal((await digest({ home, now: now + H, slot: '朝', io })).sent, false);
  // 夕枠で判断依頼が増えたら送る。
  row = { ...row, nextKim: '予算を選んでください' };
  assert.equal((await digest({ home, now: now + 8 * H, slot: '夕', io })).sent, true);
  assert.equal((await digest({ home, now: now + 9 * H, slot: '夕', io })).sent, false);
  // 同じ判断依頼のまま判定だけ変わっても、変化ではないので翌朝も送らない。
  row = { ...row, status: 'waiting_user' };
  assert.equal((await digest({ home, now: now + 24 * H, slot: '朝', io })).sent, false);
});

test('digest: 長文でも件の途中で切らず、成功した宛先を失敗後に再送しない', async () => {
  const home = tmp(), now = Date.parse('2026-10-15T09:00:00+09:00'), calls = [];
  const rows = ['a', 'b'].map(owner => ({ owner, sessionId: `session-${owner}`, status: 'stalled', ts: new Date(now - H).toISOString(), promise: '確認'.repeat(100), reason: '理由'.repeat(100), nextKim: '選択'.repeat(100) }));
  let fail = true;
  const io = { readLedger: () => rows, notifyOwner: async (owner, text) => { calls.push(owner); assert.ok(text.length <= 2000); return { delivered: owner === 'b' && fail ? 'none' : 'dm' }; } };
  assert.equal((await digest({ home, now, slot: '朝', io })).sent, false);
  fail = false;
  assert.equal((await digest({ home, now, slot: '朝', io })).sent, true);
  assert.deepEqual(calls, ['a', 'b', 'b']);
});

test('digest: 長文も一通10行以内に集約し再送しない', async () => {
  const home = tmp(), now = Date.parse('2026-10-15T09:00:00+09:00'), messages = [];
  const rows = Array.from({ length: MAX_ITEMS, needsDm, verdictOf }, (_, i) => ({ sessionId: `long-${i}`, status: 'stalled', ts: new Date(now - H).toISOString(), promise: '確認'.repeat(100), reason: '理由'.repeat(100), nextKim: '選択'.repeat(100) }));
  const io = { readLedger: () => rows, notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  const first = await digest({ home, now, slot: '朝', io });
  assert.equal(first.count, MAX_ITEMS);
  const second = await digest({ home, now, slot: '朝', io });
  assert.equal(second.sent, false);
  for (const message of messages) {
    assert.ok(message.length <= 1800);
    assert.ok(message.split('\n').length <= 10);
    assert.ok(message.includes('あなたの判断待ち:'));
  }
});

test('digest: 予定の日付と固有名詞を壊さず、対応不要もなしにまとめる', () => {
  const text = formatDigest([{ status: 'done', promise: '11/10 に Example 店を予約', nextKim: '対応は不要です（予約済み）' }]);
  assert.match(text, /11\/10 に Example 店を予約/);
  assert.doesNotMatch(text, /対応は不要/);
});

const noopExamples = ['なし', '無し', 'ナシ', '—', 'n/a', 'none', 'なし（判断待ちは発生していません）',
  'この目的は完了したので、自動で続ける作業はありません',
  'この件で Claude が続けて行う作業はありません',
  'このドキュメントについて Claude が続けて行う作業はありません。届いているマージ依頼は、次のセッションで Claude が…',
  '自動進行はありません', '自動で進める作業はありません', '続きの自動処理はありません', '特にありません',
  '完了済み。追加の自動進行なし'];
test('isNoopPromise: 作業なし宣言を記録せず、実際の約束を保持', () => {
  for (const text of noopExamples) {
    assert.equal(isNoopPromise(text), true, text);
    assert.equal(extractPromise(`この後の自動進行: ${text}`), null, text);
  }
  for (const text of ['次回の自動セッションが next-session.md の残TODO先頭を拾って続行', '17:07 に自動入札し結果を Discord に通知', '完了済み。明日再確認', '対応はないか調べる']) {
    assert.equal(isNoopPromise(text), false, text);
    assert.equal(extractPromise(`この後の自動進行: ${text}`), text);
  }
});
test('watch: noop は猶予・期限・判断待ちより先に閉じ、再開もSheet報告もしない', async () => {
  const home = tmp(), now = Date.now();
  const rows = noopExamples.map((promise, i) => ({ promise, sessionId: `noop${i}`, status: i % 2 ? 'waiting_user' : 'open', ts: new Date(now - i * H).toISOString(), cwd: home }));
  seed(home, rows);
  const io = noEvidenceIo({ resume: () => assert.fail('resume'), postSheet: () => assert.fail('sheet'), notifyOwner: () => assert.fail('notify'), transcriptEvidence: () => assert.fail('evidence') });
  assert.equal((await watch({ home, now, dryRun: true, io })).noop, rows.length);
  assert.deepEqual(readLedger(ledgerFile(home)), rows);
  const result = await watch({ home, now, io });
  assert.equal(result.noop, rows.length); assert.equal(result.resumed, 0); assert.equal(result.reported, 0);
  for (const row of readLedger(ledgerFile(home))) {
    assert.equal(row.status, 'done'); assert.equal(row.verdict, 'done');
    assert.equal(row.doneAt, new Date(now).toISOString()); assert.equal(row.reason, '自動進行の宣言なし');
  }
});
test('digest: noop はDMにも件数にも含めない', async () => {
  const now = Date.now(), home = tmp();
  const rows = noopExamples.map((promise, i) => ({ promise, sessionId: `noop${i}`, status: 'done', doneAt: new Date(now).toISOString(), ts: new Date(now - H).toISOString() }));
  const io = { readLedger: () => rows, readState: () => ({}), writeState: () => assert.fail('dry-run write'), notify: () => assert.fail('notify') };
  assert.equal((await digest({ home, slot: '朝', now, dryRun: true, io })).count, 0);
  rows.push({ sessionId: 'real', promise: '入札完了', status: 'done', doneAt: new Date(now).toISOString() });
  const result = await digest({ home, slot: '朝', now, dryRun: true, io });
  assert.equal(result.count, 1); assert.match(result.text, /完了 1/);
  assert.doesNotMatch(result.text, /作業はありません|自動進行なし/);
  assert.equal(formatDigest(rows, now), formatDigest(rows.slice(-1), now));
});
test('digest: 定型句・ID・英語ステータスを含まないクリーンアップ', () => {
  const row = { pc: 'DESKTOP-ABC1234', sessionId: 'abcdef1234567890' };
  const cleaned = cleanText('この後の自動進行: done stalled in_progress `node /tmp/run.mjs` C:\\work\\file.txt 12345678-1234-1234-1234-123456789abc', row);
  // ID・バッククォート外の絶対パス・英語ステータスは落とす。
  assert.doesNotMatch(cleaned, /この後の自動進行|done|stalled|in_progress|C:\\work|abcdef|12345678-/);
  assert.match(cleaned, /完了 止まっている 進行中/);
  // バッククォートの中身は消さずに残す（記号だけ外す）。
  assert.match(cleaned, /node \/tmp\/run\.mjs/);
  assert.doesNotMatch(cleaned, /`/);
});

test('digest: checkなしも新形式で集約しdoneは一度だけ', async () => {
  const now = Date.parse('2026-10-15T09:00:00+09:00'), home = tmp(), messages = [];
  let row = { sessionId: 'work', status: 'stalled', resumeCount: 1, nextKim: 'なし', promise: '資料を作成', ts: new Date(now - H).toISOString() };
  const io = { readLedger: () => [row], notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  assert.equal(needsDm(row, now), false);
  assert.equal((await digest({ home, now, slot: '朝', io })).sent, true);
  row = { ...row, resumeCount: MAX_RESUMES };
  assert.equal(needsDm(row, now), true);
  assert.equal((await digest({ home, now, slot: '朝', io })).sent, false);
  row = { ...row, status: 'done', doneAt: new Date(now).toISOString() };
  assert.equal((await digest({ home, now, slot: '夕', io })).sent, true);
  assert.equal((await digest({ home, now: now + WINDOW_MS, slot: '夕', io })).sent, false);
  assert.equal(messages.length, 2);
  assert.equal(needsDm({ status: 'open', dueAt: new Date(now - H).toISOString() }, now), true);
});

test('digest: 待機理由だけでは依頼せず、具体的なkimの操作がある場合のみ通知', async () => {
  const now = Date.parse('2026-10-15T09:00:00+09:00'), home = tmp(), messages = [];
  let row = { sessionId: 'waiting', status: 'waiting_user', promise: '予約', nextKim: 'なし（判断待ち）', reason: '取引先の返信待ち', ts: new Date(now - H).toISOString() };
  const io = { readLedger: () => [row], notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  assert.equal(needsDm(row, now), false);
  assert.equal((await digest({ home, now, slot: '朝', io })).sent, false);
  row = { ...row, nextKim: '予約日を選んでください' };
  assert.equal((await digest({ home, now, slot: '朝', io })).sent, true);
  assert.match(messages[0], /予約日を選んでください/);
  assert.equal((await digest({ home, now, slot: '朝', io })).sent, false);
});

// ---- 要件5 の明示テスト ----------------------------------------------------
test('digest(要件5): 枠外では送らない（skipped: outside-slot）', async () => {
  // 14:00 (枠外)
  const now = Date.parse('2026-10-15T14:00:00+09:00');
  const home = tmp();
  const row = { sessionId: 's1', status: 'open', promise: '進行中の作業', ts: new Date(now - H).toISOString() };
  const io = { readLedger: () => [row], notify: async () => assert.fail('must not notify') };
  const result = await digest({ home, now, io });
  assert.deepEqual(result, { skipped: 'outside-slot', sent: false, count: 0 });
});

test('digest(要件5): 同じ枠で2回目は送らない（skipped: already-sent）', async () => {
  // 朝枠 09:00
  const now = Date.parse('2026-10-15T09:00:00+09:00');
  const home = tmp();
  let calls = 0;
  const row = { sessionId: 's1', status: 'done', promise: '作業完了', doneAt: new Date(now).toISOString(), ts: new Date(now - H).toISOString() };
  const io = { readLedger: () => [row], notify: async () => { calls++; return { delivered: 'dm' }; } };
  const first = await digest({ home, slot: '朝', now, io });
  assert.equal(first.sent, true);
  assert.equal(calls, 1);
  const second = await digest({ home, now: now + 30 * 60000, io }); // 同じ枠 (09:30)
  assert.equal(second.skipped, 'already-sent');
  assert.equal(second.sent, false);
  assert.equal(calls, 1);
});

test('digest(要件5): 判断待ちの新規は枠外でも1回だけ送る（同一項目は1回だけ）', async () => {
  // 14:00 (枠外)
  const now = Date.parse('2026-10-15T14:00:00+09:00');
  const home = tmp();
  let calls = 0;
  const row = { sessionId: 'urgent-1', status: 'waiting_user', nextKim: '振込の承認をお願いします', promise: '支払い手続き', ts: new Date(now - 1000).toISOString() };
  const io = { readLedger: () => [row], notify: async (text) => {
    calls++;
    assert.match(text, /あなたの判断待ち:.*支払い手続き — 振込の承認をお願いします/);
    return { delivered: 'dm' };
  } };
  const first = await digest({ home, slot: '朝', now, io });
  assert.equal(first.sent, true);
  assert.equal(calls, 1);
  // 同じ判断待ち項目に対して、再度枠外で呼ばれた場合は送らない（同一項目は1回だけ）
  const second = await digest({ home, now: now + 3600000, io });
  assert.deepEqual(second, { skipped: 'outside-slot', sent: false, count: 0 });
  assert.equal(calls, 1);
});

test('digest(要件5): 変化0件なら送らない', async () => {
  // 朝枠 09:00 で変化なし (open のまま)
  const now = Date.parse('2026-10-15T09:00:00+09:00');
  const home = tmp();
  const row = { sessionId: 's1', status: 'open', promise: '進行中の作業', ts: new Date(now - H).toISOString() };
  let calls = 0;
  const io = {
    readLedger: () => [row],
    readState: () => ({ lastVerdicts: { [rowKey(row)]: 'open' }, lastKim: { [rowKey(row)]: 'なし' }, lastWaiting: { [rowKey(row)]: false } }),
    notify: async () => { calls++; return { delivered: 'dm' }; },
  };
  const result = await digest({ home, now, slot: '朝', io });
  assert.deepEqual(result, { sent: false, count: 0 });
  assert.equal(calls, 0);
});

test('digest(要件5): 61件相当でも1通・1800字以内・「ほか N 件」にまとめる', () => {
  // 61件の行を作成
  const doneRows = Array.from({ length: 40 }, (_, i) => ({
    sessionId: `done-${i}`, status: 'done', promise: `機能${i}の実装と検証完了`,
  }));
  const waitingRows = Array.from({ length: 11 }, (_, i) => ({
    sessionId: `wait-${i}`, status: 'waiting_user', promise: `顧客${i}への見積もり`, nextKim: `見積もり金額${i}を承認`,
  }));
  const stalledRows = Array.from({ length: 10 }, (_, i) => ({
    sessionId: `stall-${i}`, status: 'stalled', promise: `タスク${i}の自動進行`, resumeCount: 8,
  }));
  const all = [...waitingRows, ...doneRows, ...stalledRows];
  assert.equal(all.length, 61);

  const text = formatDigest([], Date.now(), '作業用011', {
    allRows: all,
    waitingRows,
    doneRows,
    stalledRows,
    inProgressCount: 5,
  });

  // 1行目の形式
  assert.match(text, /^【作業用011 の自動進行】 完了 40件・止まっている 10件・あなたの判断待ち 11件/);
  // あなたの判断待ちが最上段
  const lines = text.split('\n');
  assert.match(lines[1], /^・あなたの判断待ち:/);
  // 「ほか N 件」が含まれる
  assert.match(text, /・あなたの判断待ち: ほか \d+件/);
  assert.match(text, /・完了: ほか \d+件/);
  assert.match(text, /・止まっている: ほか \d+件/);
  // 1800字以内
  assert.ok(text.length <= 1800, `text length was ${text.length}`);
});

// ---- 進捗DMの中身（2026-10-23 追加修正） ------------------------------------
test('digest: 72時間より古い判断待ちは個別に出さず、末尾の集計1行にまとめる', () => {
  const now = Date.parse('2026-10-23T19:16:00+09:00');
  const fresh = [
    { sessionId: 'f1', status: 'waiting_user', promise: '見積の承認', nextKim: '金額を承認', ts: new Date(now - 2 * H).toISOString() },
    { sessionId: 'f2', status: 'waiting_user', promise: '入稿データ確認', nextKim: 'データを確認', ts: new Date(now - 71 * H).toISOString() },
  ];
  const stale = Array.from({ length: 20 }, (_, i) => ({
    sessionId: `old-${i}`, status: 'waiting_user', promise: `古い判断待ち${i}`, nextKim: `古い作業${i}を承認`,
    ts: new Date(now - (73 + i) * H).toISOString(),
  }));
  const closed = { sessionId: 'closed', status: 'superseded', promise: '更新済みの判断待ち', nextKim: '更新済みの操作', ts: new Date(now - H).toISOString() };
  const all = [...fresh, ...stale, closed];
  const text = formatDigest([], now, '作業用011', { allRows: all, waitingRows: all, doneRows: [], stalledRows: [] });
  assert.match(text, /あなたの判断待ち 2件/);
  assert.match(text, /・あなたの判断待ち: 見積の承認/);
  assert.match(text, /・あなたの判断待ち: 入稿データ確認/);
  // 72時間より古い分・閉じた分は個別に出さない
  assert.doesNotMatch(text, /古い判断待ち|古い作業|更新済みの判断待ち/);
  assert.equal(text.split('\n').at(-1), '・3日以上前の判断待ち 20件（必要なら次のセッションで整理します）');
});

test('digest: バッククォートの中身を残し、文に穴を開けない', () => {
  const backticked = formatDigest([], Date.now(), 'cr-PC', {
    waitingRows: [{ sessionId: 'a', status: 'waiting_user', promise: '`settings.json` と `orgiast-claude-rules` で同期すれば解禁される', nextKim: '' }],
    doneRows: [], stalledRows: [],
  });
  assert.match(backticked, /settings\.json と orgiast-claude-rules で同期すれば解禁される/);
  assert.doesNotMatch(backticked, /後に と で|`/);
  const command = formatDigest([], Date.now(), 'cr-PC', {
    waitingRows: [{ sessionId: 'b', status: 'waiting_user', promise: 'PR #782 のマージ', nextKim: '`git push` を実行してから承認してください' }],
    doneRows: [], stalledRows: [],
  });
  assert.match(command, /PR #782 のマージ — git push を実行してから承認してください/);
  assert.doesNotMatch(command, /`/);
});

test('digest: 判断待ちが22件でも完了・止まっているの行が必ず出る（1800字・最大5件）', () => {
  const now = Date.parse('2026-10-23T19:16:00+09:00');
  const waitingRows = Array.from({ length: 22 }, (_, i) => ({
    sessionId: `w${i}`, status: 'waiting_user', promise: `判断${i}${'長い説明'.repeat(30)}`, nextKim: `操作${i}${'確認事項'.repeat(30)}`,
    ts: new Date(now - i * H).toISOString(),
  }));
  const doneRows = Array.from({ length: 2 }, (_, i) => ({ sessionId: `d${i}`, status: 'done', promise: `完了作業${i}`, doneAt: new Date(now).toISOString(), ts: new Date(now - H).toISOString() }));
  const stalledRows = Array.from({ length: 5 }, (_, i) => ({ sessionId: `s${i}`, status: 'stalled', promise: `停滞${i}`, ts: new Date(now - H).toISOString() }));
  const text = formatDigest([], now, '作業用011', {
    allRows: [...waitingRows, ...doneRows, ...stalledRows], waitingRows, doneRows, stalledRows, inProgressCount: 7,
  });
  assert.match(text, /^【作業用011 の自動進行】 完了 2件・止まっている 5件・あなたの判断待ち 22件/);
  assert.match(text, /・あなたの判断待ち: 判断0/);
  assert.match(text, /・完了: 完了作業0/);
  assert.match(text, /・止まっている: 停滞0/);
  assert.match(text, /・あなたの判断待ち: ほか \d+件/);
  assert.doesNotMatch(text, /・完了: ほか/); // 完了は2件なので全件出す
  // 止まっているは5件＝上限内なので全件を名前で出す（「ほか」は付けない）
  assert.match(text, /・止まっている: 停滞4 — 自動再開していません/);
  assert.doesNotMatch(text, /・止まっている: ほか/);
  const lines = text.split('\n');
  assert.ok(text.length <= 1800, `text length was ${text.length}`);
  for (const line of lines.filter(l => l.startsWith('・'))) {
    assert.ok(line.length <= 80, `line too long (${line.length}): ${line}`);
  }
});

test('digest: 各区分は1800字に収まる限り最大5件を名前で出し、超過分だけ「ほか N 件」', () => {
  const now = Date.parse('2026-10-23T19:16:00+09:00');
  const make = (prefix, n, extra) => Array.from({ length: n }, (_, i) => ({
    sessionId: `${prefix}${i}`, promise: `${prefix}作業${i}`, ts: new Date(now - i * 60000).toISOString(), ...extra,
  }));
  const waitingRows = make('判断', 8, { status: 'waiting_user', nextKim: '承認' });
  const doneRows = make('完了', 8, { status: 'done', doneAt: new Date(now).toISOString() });
  const stalledRows = make('停滞', 8, { status: 'stalled' });
  const inProgressRows = make('進行', 8, { status: 'open' });
  const text = formatDigest([], now, 'PC', { waitingRows, doneRows, stalledRows, inProgressRows });

  for (const [label, prefix] of [['あなたの判断待ち', '判断'], ['完了', '完了'], ['止まっている', '停滞'], ['進行中', '進行']]) {
    const items = text.split('\n').filter(line => line.startsWith(`・${label}:`) && !line.includes('ほか'));
    assert.equal(items.length, 5, `${label} は5件`);
    for (let i = 0; i < 5; i++) assert.match(text, new RegExp(`・${label}: (?:［[^］]*］)?${prefix}作業${i}`));
    assert.doesNotMatch(text, new RegExp(`・${label}: .*${prefix}作業5`));
    assert.match(text, new RegExp(`・${label}: ほか 3件`));
  }
  assert.ok(text.length <= 1800, `text length was ${text.length}`);
});

test('digest: 進行中も件数だけでなく名前で出す（最終判定が新しい順）', () => {
  const now = Date.parse('2026-10-23T19:16:00+09:00');
  const inProgressRows = [
    { sessionId: 'old', status: 'open', promise: '古い作業', lastCheckedAt: new Date(now - 3 * H).toISOString() },
    { sessionId: 'new', status: 'open', promise: '新しい作業', lastCheckedAt: new Date(now - H).toISOString() },
  ];
  const text = formatDigest([], now, 'PC', { waitingRows: [], doneRows: [], stalledRows: [], inProgressRows });
  assert.deepEqual(text.split('\n').filter(line => line.startsWith('・進行中')), [
    '・進行中: 新しい作業',
    '・進行中: 古い作業',
  ]);
  assert.doesNotMatch(text, /・進行中: \d+件/);
});

test('digest: 送信した本文を sent.jsonl に残し、dryRun では書かない', async () => {
  const home = tmp(), at = Date.parse('2026-10-23T09:00:00+09:00');
  const sentFile = path.join(home, '.claude', 'logs', 'auto-progress-digest.sent.jsonl');
  const readSent = () => (fs.existsSync(sentFile) ? fs.readFileSync(sentFile, 'utf8').trim().split('\n').map(JSON.parse) : []);
  const row = { sessionId: 's1', owner: 'kim@orgiast.jp', status: 'waiting_user', promise: '見積の承認', nextKim: '金額を承認', ts: new Date(at - H).toISOString() };
  const base = { readLedger: () => [row], localOwner: 'kim@orgiast.jp' };

  // dryRun では書かない
  const dry = await digest({ home, now: at, slot: '朝', dryRun: true, io: { ...base, notify: async () => assert.fail('dryRun must not send') } });
  assert.ok(dry.text.includes('見積の承認'));
  assert.equal(fs.existsSync(sentFile), false);

  // 送信失敗も記録し、本文は redact を通して残す
  await digest({ home, now: at, slot: '朝', io: { ...base, notify: async () => ({ delivered: 'none', reason: 'webhook 401' }) } });
  let log = readSent();
  assert.equal(log.length, 1);
  assert.equal(log[0].sent, false);
  assert.equal(log[0].slot, '2026-10-23|朝');
  assert.ok(log[0].text.includes('見積の承認'));
  assert.equal(log[0].parts, 1);
  assert.ok(Number.isFinite(Date.parse(log[0].at)));

  // 送信成功も記録し、送った本文そのものを残す
  const sent = await digest({ home, now: at, slot: '朝', io: { ...base, notify: async () => ({ delivered: 'dm' }) } });
  assert.equal(sent.sent, true);
  log = readSent();
  assert.equal(log.length, 2);
  assert.equal(log[1].sent, true);
  assert.equal(log[1].count, 1);
  assert.ok(log[1].text.includes('見積の承認'));
  assert.ok(log[1].text.startsWith('【'));
  assert.equal(log[1].slot, log[0].slot);
  assert.match(log[1].slot, /\|朝$/);
});

test('digest(要件5): 1件が極端に長くても1800字以内・1通に収める', () => {
  const text = formatDigest([], Date.now(), 'PC', {
    allRows: [{ promise: 'x', status: 'waiting_user' }],
    waitingRows: [{ promise: '件名'.repeat(500), nextKim: '操作'.repeat(500) }],
    doneRows: [],
    stalledRows: [],
  });
  assert.ok(text.length <= 1800, `text length was ${text.length}`);
  assert.match(text, /・あなたの判断待ち:/);
});

test('watch: resumed のまま上限に達した行も停滞確認後はDM対象にする', async () => {
  const home = tmp(), now = Date.now();
  seed(home, [{ sessionId: 'exhausted', status: 'resumed', resumeCount: MAX_RESUMES, nextKim: 'なし', promise: '資料作成', ts: new Date(now - 3 * H).toISOString(), cwd: home }]);
  const result = await watch({ home, now, io: noEvidenceIo({ resume: () => assert.fail('resume') }) });
  assert.equal(result.resumed, 0);
  const row = readLedger(ledgerFile(home))[0];
  assert.equal(verdictOf(row, now), 'stalled'); assert.equal(needsDm(row, now), true);
});

test('originLine: PC ラベル・アカウント・プロジェクト・目的を1行に出す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-'));
  fs.mkdirSync(path.join(home, '.claude', 'session-purpose'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session-purpose', 'abcdef1234.json'), JSON.stringify({ purpose: '学会協賛 62社へ案内メール' }));
  const row = { pc: 'DESKTOP-X', owner: '', user: 'cr', cwd: 'C:/Users/cr/Downloads/学会協賛ナビ/',sessionId: 'abcdef1234' };
  assert.equal(originLine(row, { label: '作業用001', localOwner: 'cr@orgiast.jp', home }),
    '【作業用001（DESKTOP-X）・cr@orgiast.jp の Claude Code】プロジェクト: 学会協賛ナビ ／ セッションの目的: 学会協賛 62社へ案内メール ／ 作業ID: abcdef12');
  assert.match(originLine({ pc: 'H', user: 'u' }), /^【H・u の Claude Code】プロジェクト: 不明$/);
});

test('watch: 判断待ち通知に出どころ行が付き、owner 空なら自PCの持ち主へ送る', async () => {
  const home = tmp(), now = Date.parse('2026-10-23T00:00:00Z');
  seed(home, [{ sessionId: 's1', owner: '', pc: 'PC', status: 'waiting_user', nextKim: '62社への送信を承認', promise: '62社へ送信', reason: 'OK 待ち', cwd: 'C:\\w\\案件A', ts: new Date(now - 3 * 3600000).toISOString() }]);
  const sent = [];
  await watch({ home, now, io: { label: '作業用001', localOwner: 'cr@orgiast.jp', sheetConfig: () => null, digest: async () => ({}), notifyOwner: async (owner, text) => { sent.push({ owner, text }); return { delivered: 'dm' }; } } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].owner, 'cr@orgiast.jp');
  assert.match(sent[0].text, /^【作業用001（PC）・cr@orgiast\.jp の Claude Code】プロジェクト: 案件A/);
  assert.match(sent[0].text, /自動進行が判断待ちです: 62社へ送信\nOK 待ち/);
});

test('watch: 自動進行完了時に結果の中身つきDMを1通送り、2回目は送らない（doneNotifiedAtで重複防止）', async () => {
  // (a) resume が done を返すと notifyOwner が1回呼ばれ、本文に「結果:」と成果物パスが含まれる
  // (b) 2回目の巡回では送られない（doneNotifiedAt）
  const home = tmp();
  const now = Date.parse('2026-10-23T12:00:00Z');
  seed(home, [{
    sessionId: 'session-done-1',
    ts: new Date(now - 10 * H).toISOString(),
    status: 'open',
    promise: 'テストの自動完了',
    cwd: home,
    pc: 'PC-test',
    user: 'u-test',
  }]);

  const notices = [];
  const appendLogs = [];
  const io = noEvidenceIo({
    resume: async () => ({
      outcome: 'done',
      state: 'done',
      reason: 'テスト実行に成功し、全件パスしました。\n詳細はログを確認。',
      artifact: 'reports/summary.md',
    }),
    notifyOwner: async (owner, text) => {
      notices.push({ owner, text });
      return { delivered: 'dm' };
    },
    appendFileSync: (file, content) => {
      appendLogs.push({ file, content });
    },
  });

  const first = await watch({ home, now, io });
  assert.equal(notices.length, 1);
  const msg = notices[0].text;
  assert.match(msg, /✅ 自動進行が完了しました/);
  assert.match(msg, /約束: テストの自動完了/);
  assert.match(msg, /結果: テスト実行に成功し、全件パスしました。\n詳細はログを確認。/);
  assert.match(msg, /成果物: reports\/summary\.md/);
  assert.match(msg, /kim がすること: なし/);

  // 台帳に doneNotifiedAt が記録されていること
  const rowsAfterFirst = readLedger(ledgerFile(home));
  assert.equal(rowsAfterFirst[0].status, 'done');
  assert.equal(rowsAfterFirst[0].doneNotifiedAt, new Date(now).toISOString());

  // sent.jsonl に記録されていること
  const sentLog = appendLogs.find(l => l.file.endsWith('auto-progress-done-dm.sent.jsonl'));
  assert.ok(sentLog, 'sent.jsonl logged');
  const loggedRecord = JSON.parse(sentLog.content.trim());
  assert.equal(loggedRecord.sessionId, 'session-done-1');
  assert.equal(loggedRecord.delivered, 'dm');
  assert.equal(loggedRecord.at, new Date(now).toISOString());
  assert.ok(loggedRecord.text.startsWith(msg.slice(0, 50)));

  // (b) 2回目の巡回では送られない（doneNotifiedAt）
  const second = await watch({ home, now: now + H, io });
  assert.equal(notices.length, 1, '2回目の巡回では送られない');
});

test('watch: delivered!==dm なら doneNotifiedAt が付かず、errors に notify-done が入る', async () => {
  // (c) delivered!=='dm' なら doneNotifiedAt が付かず、errors に notify-done が入る
  const home = tmp();
  const now = Date.parse('2026-10-23T12:00:00Z');
  seed(home, [{
    sessionId: 'session-fail-1',
    ts: new Date(now - 10 * H).toISOString(),
    status: 'open',
    promise: '通知失敗のテスト',
    cwd: home,
    pc: 'PC-test',
    user: 'u-test',
  }]);

  const notices = [];
  const appendLogs = [];
  const io = noEvidenceIo({
    resume: async () => ({
      outcome: 'done',
      state: 'done',
      reason: '処理は完了',
      artifact: '',
    }),
    notifyOwner: async (owner, text) => {
      notices.push({ owner, text });
      return { delivered: 'none', reason: 'Discord rate limit' };
    },
    appendFileSync: (file, content) => {
      appendLogs.push({ file, content });
    },
  });

  const result = await watch({ home, now, io });
  assert.equal(notices.length, 1);
  assert.ok(result.errors.some(e => e.includes('notify-done: Discord rate limit')));

  const rows = readLedger(ledgerFile(home));
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[0].doneNotifiedAt, undefined);

  // sent.jsonl には delivered: 'none' で記録されること
  const sentLog = appendLogs.find(l => l.file.endsWith('auto-progress-done-dm.sent.jsonl'));
  assert.ok(sentLog);
  const loggedRecord = JSON.parse(sentLog.content.trim());
  assert.equal(loggedRecord.delivered, 'none');
});

test('watch: judge 経由の done でも通知され、成果物は「なし」になる', async () => {
  // (d) judge 経由の done でも送られる
  const home = tmp();
  const now = Date.parse('2026-10-23T12:00:00Z');
  seed(home, [{
    sessionId: 'session-judge-1',
    ts: new Date(now - 10 * H).toISOString(),
    status: 'open',
    promise: '判定完了テスト',
    cwd: home,
    pc: 'PC-test',
    user: 'u-test',
  }]);

  const notices = [];
  const io = baseIo({
    transcriptEvidence: () => ({ count: 1, lastAt: now - 8 * H, snippets: ['完了しました'] }),
    recentFiles: () => ({ lastAt: 0, names: [] }),
    autoSessionRuns: () => ({ lastAt: 0, names: [] }),
    askLlm: () => 'done | 全て完了している',
    notifyOwner: async (owner, text) => {
      notices.push({ owner, text });
      return { delivered: 'dm' };
    },
  });

  const result = await watch({ home, now, io });
  assert.equal(result.done, 1);
  assert.equal(notices.length, 1);
  const msg = notices[0].text;
  assert.match(msg, /✅ 自動進行が完了しました/);
  assert.match(msg, /約束: 判定完了テスト/);
  assert.match(msg, /結果: 全て完了している/);
  assert.match(msg, /成果物: なし/);
  assert.match(msg, /kim がすること: なし/);

  const rows = readLedger(ledgerFile(home));
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[0].doneNotifiedAt, new Date(now).toISOString());
});

test('formatDoneMessage: 1900字を超えず、readableで改行を保ちpc/sessionIdを置換する', () => {
  // (e) 1900 字を超えない
  const longReason = 'PC-SECRET の session-xyz で1行目の結果説明\n2行目の長いテキスト: ' + 'あ'.repeat(2000);
  const longPromise = '長い約束: ' + 'い'.repeat(500);
  const row = {
    sessionId: 'session-xyz',
    pc: 'PC-SECRET',
    promise: longPromise,
    cwd: '/path/to/project',
  };
  const reasonResult = readableReason(longReason, row, 1200);
  assert.ok(reasonResult.includes('このパソコン'));
  assert.ok(reasonResult.includes('この作業'));
  assert.ok(!reasonResult.includes('PC-SECRET'));
  assert.ok(!reasonResult.includes('session-xyz'));
  assert.match(reasonResult, /このパソコン の この作業 で1行目の結果説明\n2行目の長いテキスト/);

  const message = formatDoneMessage(row, {
    reason: longReason,
    artifact: 'path/to/' + 'う'.repeat(200),
    home: '/tmp/test',
  });
  assert.ok(message.length <= 1900, `Message length ${message.length} exceeds 1900`);
});

test('watch: 完了DMの送信に失敗した行は次の巡回で再送し、成功したら doneNotifiedAt を付ける', async () => {
  const home = tmp();
  const now = Date.parse('2026-10-23T12:00:00Z');
  seed(home, [{
    sessionId: 'session-retry-1',
    ts: new Date(now - 10 * H).toISOString(),
    status: 'open',
    promise: '再送テスト',
    cwd: home,
    pc: 'PC-test',
    user: 'u-test',
  }]);

  const first = await watch({ home, now, io: noEvidenceIo({
    resume: async () => ({ outcome: 'done', state: 'done', reason: '完了しました', artifact: 'out/result.md' }),
    notifyOwner: async () => ({ delivered: 'none', reason: 'network down' }),
  }) });
  assert.ok(first.errors.some(e => e.includes('notify-done: network down')));
  let rows = readLedger(ledgerFile(home));
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[0].doneNotifyPending, true);
  assert.equal(rows[0].doneNotifiedAt, undefined);

  // done は open の集合から外れるので、印が無いと二度と拾えない＝ここで再送されること。
  const notices = [];
  const second = await watch({ home, now: now + H, io: noEvidenceIo({
    resume: () => assert.fail('must not resume again'),
    notifyOwner: async (owner, text) => { notices.push({ owner, text }); return { delivered: 'dm' }; },
  }) });
  assert.equal(second.errors.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /✅ 自動進行が完了しました/);
  assert.match(notices[0].text, /結果: 完了しました/);
  assert.match(notices[0].text, /成果物: out\/result\.md/);
  rows = readLedger(ledgerFile(home));
  assert.equal(rows[0].doneNotifiedAt, new Date(now + H).toISOString());
  assert.equal(rows[0].doneNotifyPending, false);

  // 3回目は送らない。
  await watch({ home, now: now + 2 * H, io: noEvidenceIo({ resume: () => assert.fail('must not resume'), notifyOwner: () => assert.fail('must not notify') }) });
});
