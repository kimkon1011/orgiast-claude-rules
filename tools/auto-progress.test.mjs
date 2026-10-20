import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';
import { main as registerTasks } from './register-auto-progress-task.mjs';
import { isNoopPromise, extractPromise, extractNextKim, applyPromise, buildRecord, record, readLedger, ledgerFile, rowKey } from './auto-progress-ledger.mjs';
import { run as watch, parseVerdict, deterministicVerdict, judge, GRACE_MS, RESUME_INTERVAL_MS, MAX_RESUMES, postSheet, resumeSession, recentFiles, EXPIRE_UNATTENDED_MS, FALLBACK_STALL_MS } from './auto-progress-watch.mjs';
import { run as digest, selectRows, formatDigest, isUnattendedRow, WINDOW_MS, MAX_ITEMS, needsDm, verdictOf } from './auto-progress-digest.mjs';
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
const baseIo = (extra = {}) => ({ sheetConfig: () => ({ url: 'u', token: 't' }), cwdExists: () => true, digest: async () => ({ sent: false, count: 0 }), ...extra });
const evAny = (now) => ({ transcript: { count: 1, lastAt: now - 8 * H, snippets: [] }, files: { names: [], lastAt: 0 }, runs: { names: [] }, lastEvidenceAt: now - 8 * H, any: true });

test('watch: 猶予1時間未満は判定しない', async () => {
  const home = tmp(); const now = Date.now();
  seed(home, [{ sessionId: 's', ts: new Date(now - H / 2).toISOString(), status: 'open', promise: 'p', cwd: home, pc: 'PC' }]);
  const calls = [];
  const s = await watch({ home, now, io: baseIo({ gatherEvidence: undefined, transcriptEvidence: () => { calls.push(1); return { count: 0, lastAt: 0, snippets: [] }; } }) });
  assert.equal(s.graced, 1); assert.equal(s.checked, 0); assert.equal(calls.length, 0);
  assert.equal(GRACE_MS, H);
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
    const home = tmp(); seed(home, [{ sessionId: state, owner: 'cr@orgiast.jp', ts: new Date(now - 3 * H).toISOString(), status: 'open', promise: state, cwd: home, pc: 'PC' }]);
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
  const now = Date.parse('2026-10-15T00:00:00Z');
  const rows = [
    { sessionId: 'k1', pc: 'other-PC', nextKim: '公開を確認', promise: '夜間デプロイ', ts: new Date(now - 30 * H).toISOString(), lastCheckedAt: new Date(now - H).toISOString(), status: 'open' },
  ];
  assert.equal(selectRows(rows, now).length, 1);
  const text = formatDigest(selectRows(rows, now), now, 'other-PC');
  assert.match(text, /^自動進行 まとめ: 進んでいる 1/);
  assert.match(text, /未処理 1 件・最古 1 日前/);
  assert.match(text, /・夜間デプロイ\n  今: 進んでいます/);
  const sent = [];
  const io = { label: 'other-PC', readLedger: () => rows, readState: () => ({}), writeState: () => {}, appendFileSync: () => {}, mkdirSync: () => {}, notify: async (t) => { sent.push(t); return { delivered: 'dm' }; } };
  assert.deepEqual(await digest({ home: tmp(), now, io }), { sent: true, count: 1, parts: 1 });
  assert.equal(sent.length, 1);
  assert.deepEqual(await digest({ home: tmp(), now, io: { ...io, readLedger: () => [] } }), { sent: false, count: 0 });
  assert.equal(sent.length, 1);
});

test('digest: 同一スロット・同一内容を二重送信せず、doneは前回成功以降だけ含む', async () => {
  const now = Date.parse('2026-10-15T09:05:00+09:00');
  const recent = { status: 'done', promise: 'recent', ts: new Date(now - 10 * H).toISOString(), doneAt: new Date(now - H).toISOString() };
  const old = { status: 'done', promise: 'old', ts: new Date(now - 20 * H).toISOString(), doneAt: new Date(now - 5 * H).toISOString() };
  let saved;
  const io = { label: 'cr-PC', readLedger: () => [old, recent], readState: () => saved || { lastSuccessAt: new Date(now - 2 * H).toISOString() }, writeState: (_h, value) => { saved = value; }, appendFileSync: () => {}, mkdirSync: () => {}, notify: async () => ({ delivered: 'dm' }) };
  assert.deepEqual(await digest({ home: tmp(), now, slot: '朝', io }), { sent: true, count: 1, parts: 1 });
  assert.deepEqual(await digest({ home: tmp(), now, slot: '朝', io }), { sent: false, count: 0 });
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
  const result = await digest({ home: tmp(), now, io: {
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

test('digest: 10件を超えた行と新規doneは次回へ繰り越す', async () => {
  const now = Date.now(), home = tmp();
  const rows = Array.from({ length: MAX_ITEMS + 2 }, (_, i) => ({ sessionId: `s${i}`, status: 'done', promise: `作業${i}`, ts: new Date(now - WINDOW_MS).toISOString(), doneAt: new Date(now - H).toISOString() }));
  const messages = [];
  const io = { readLedger: () => rows, notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  const first = await digest({ home, now, io });
  assert.equal(first.count, MAX_ITEMS);
  assert.match(messages[0], /…ほか 2 件（次回以降に）/);
  assert.equal((await digest({ home, now: now + WINDOW_MS, io })).count, 2);
  assert.deepEqual(await digest({ home, now: now + WINDOW_MS * 2, io }), { sent: false, count: 0 });
  assert.ok(messages.every(message => message.length <= 2000));
});

test('schedule: watchは毎時・4件分の時間枠を確保し既存PCも更新する', () => {
  const script = fs.readFileSync(new URL('./register-auto-progress-task.ps1', import.meta.url), 'utf8');
  const triggers = script.match(/\$watchTriggers = (.*)/)[1];
  assert.deepEqual([...triggers.matchAll(/-At '([^']+)'/g)].map(m => m[1]), ['00:00']);
  assert.match(triggers, /New-TimeSpan -Hours 1/);
  assert.match(script, /-ExecutionTimeLimit \(New-TimeSpan -Minutes 120\)/);
  const poller = fs.readFileSync(new URL('./fleet-poller.ps1', import.meta.url), 'utf8');
  assert.match(poller, /if \(\$Dry\) \{ DrySkip 'register-auto-progress-task.ps1/);
  assert.match(poller, /-File \$autoProgressInstaller/);
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
  const rows = ['a', 'b'].map(owner => ({ owner, sessionId: `session-${owner}`, status: 'waiting_user', promise: owner === 'a' ? '資料の確認' : '見積の確認', ts: new Date(now - H).toISOString() }));
  const result = await digest({ home: tmp(), now, io: {
    label: 'PC', readLedger: () => rows, readState: () => ({}), writeState() {},
    notifyOwner: async (owner, text) => { calls.push({ owner, text }); return { delivered: 'dm' }; },
  } });
  assert.equal(result.sent, true);
  assert.deepEqual(calls.map(c => c.owner), ['a', 'b']);
  assert.match(calls[0].text, /資料の確認/); assert.doesNotMatch(calls[0].text, /見積の確認/);
  assert.match(calls[1].text, /見積の確認/); assert.doesNotMatch(calls[1].text, /資料の確認/);
});

test('watch retries undelivered needs_user notification without waiting 24 hours', async () => {
  const home = tmp(), now = Date.now(); let attempts = 0;
  seed(home, [{ sessionId: 'waiting', owner: 'a', status: 'open', promise: 'p', cwd: home, ts: new Date(now - 3 * H).toISOString() }]);
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
  const home = tmp(), now = Date.now();
  const row = { pc: 'DESKTOP-2D0R4LI', sessionId: 'abcdef12', status: 'done', doneAt: new Date(now).toISOString(), ts: new Date(now - H).toISOString(), nextKim: 'なし（確認済み）', promise: 'DESKTOP-2D0R4LI の abcdef12 を 2026-10-20T01:02:03Z に確認', reason: '確認完了' };
  const unattended = { ...row, sessionId: 'batch', cwd: path.join(home, '.claude', 'scratch', 'test'), promise: '表示しない約束' };
  const result = await digest({ home, now, dryRun: true, io: { readLedger: () => [row, unattended], readState: () => ({}) } });
  assert.equal(result.count, 1);
  assert.match(result.text, /無人処理の約束 1 件は数だけ/);
  assert.match(result.text, /次に自動でやること:.*kim がすること: なし/);
  assert.match(result.text, /このパソコン の この作業 を 2026-10-20T01:02:03Z に確認/);
  assert.doesNotMatch(result.text, /DESKTOP-|abcdef12|表示しない約束/);
  assert.doesNotMatch(result.text.split('\n').filter(line => !line.startsWith('・')).join('\n'), /2026-10-|DESKTOP-|abcdef12/);
  assert.deepEqual(await digest({ home, now, dryRun: true, io: { readLedger: () => [unattended], readState: () => ({}) } }), { sent: false, count: 0 });
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

test('digest: 同じ判定は再送せず、判断依頼の追加と判定変化だけ送る', async () => {
  const home = tmp(), now = Date.now();
  let row = { sessionId: 's', ts: new Date(now - H).toISOString(), status: 'open', promise: '資料確認' };
  const io = { readLedger: () => [row], notify: async () => ({ delivered: 'dm' }) };
  assert.equal((await digest({ home, now, io })).sent, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'state', 'auto-progress-digest.json'), 'utf8')).lastVerdicts[rowKey(row)], 'open');
  assert.equal((await digest({ home, now: now + H, io })).sent, false);
  row = { ...row, nextKim: '予算を選んでください' };
  assert.equal((await digest({ home, now: now + H, io })).sent, true);
  assert.equal((await digest({ home, now: now + H, io })).sent, false);
  row = { ...row, status: 'waiting_user' };
  assert.equal((await digest({ home, now: now + H, io })).sent, true);
});

test('digest: 長文でも件の途中で切らず、成功した宛先を失敗後に再送しない', async () => {
  const home = tmp(), now = Date.now(), calls = [];
  const rows = ['a', 'b'].map(owner => ({ owner, sessionId: `session-${owner}`, status: 'stalled', ts: new Date(now - H).toISOString(), promise: '確認'.repeat(100), reason: '理由'.repeat(100), nextKim: '選択'.repeat(100) }));
  let fail = true;
  const io = { readLedger: () => rows, notifyOwner: async (owner, text) => { calls.push(owner); assert.ok(text.length <= 2000); return { delivered: owner === 'b' && fail ? 'none' : 'dm' }; } };
  assert.equal((await digest({ home, now, io })).sent, false);
  fail = false;
  assert.equal((await digest({ home, now, io })).sent, true);
  assert.deepEqual(calls, ['a', 'b', 'b']);
});

test('digest: 長文の上限超過分は次回に送り、件の3行を維持する', async () => {
  const home = tmp(), now = Date.now(), messages = [];
  const rows = Array.from({ length: MAX_ITEMS, needsDm, verdictOf }, (_, i) => ({ sessionId: `long-${i}`, status: 'stalled', ts: new Date(now - H).toISOString(), promise: '確認'.repeat(100), reason: '理由'.repeat(100), nextKim: '選択'.repeat(100) }));
  const io = { readLedger: () => rows, notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  const first = await digest({ home, now, io });
  assert.ok(first.count < MAX_ITEMS);
  const second = await digest({ home, now, io });
  assert.equal(first.count + second.count, MAX_ITEMS);
  for (const message of messages) {
    assert.ok(message.length <= 2000);
    assert.equal((message.match(/^・/gm) || []).length, (message.match(/kim がすること:/g) || []).length);
  }
});

test('digest: 予定の日付と固有名詞を壊さず、対応不要もなしにまとめる', () => {
  const text = formatDigest([{ status: 'open', promise: '11/10 に Example 店を予約', nextKim: '対応は不要です（予約済み）' }]);
  assert.match(text, /11\/10 に Example 店を予約/);
  assert.match(text, /kim がすること: なし/);
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
  assert.equal((await digest({ home, now, dryRun: true, io })).count, 0);
  rows.push({ sessionId: 'real', promise: '入札完了', status: 'done', doneAt: new Date(now).toISOString() });
  const result = await digest({ home, now, dryRun: true, io });
  assert.equal(result.count, 1); assert.match(result.text, /終わった 1/);
  assert.doesNotMatch(result.text, /作業はありません|自動進行なし/);
  assert.equal(formatDigest(rows, now), formatDigest(rows.slice(-1), now));
});
test('digest: 原文の語彙・パス・日時・番号を保持し、理由は定型のみ短縮', () => {
  for (const promise of ['Claude Discord Drive GAS TODO DM PR CI SLA', 'next-session.md yj-1248206188 abcdef123456', '`/tmp/file` C:\\work 2026-10-20T01:02:03Z']) {
    assert.ok(formatDigest([{ promise, status: 'done' }]).includes(promise));
  }
  for (const [reason, expected] of [
    ['証拠なし（約束後の会話・ファイル更新・実行ログが無い）', 'その後の動きがありません'],
    ['最後の動きから1時間以上経過', 'しばらく動きがありません'],
    ['最後の動きから24時間以上経過', 'しばらく動きがありません'],
    ['直近1時間以内に動きあり', '動いています'], ['判定AIが使えず様子見', '判定AIが使えず様子見'], ['Discord の返事待ち', 'Discord の返事待ち'],
  ]) assert.ok(formatDigest([{ promise: '確認', reason }]).includes(`（${expected}）`));
});
test('digest: stalledの初回は記録だけ、同じ判定で上限到達したら送りdoneは一度だけ', async () => {
  const now = Date.now(), home = tmp(), messages = [];
  let row = { sessionId: 'work', status: 'stalled', resumeCount: 1, nextKim: 'なし', promise: '資料を作成', ts: new Date(now - H).toISOString() };
  const io = { readLedger: () => [row], notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  assert.equal(needsDm(row, now), false);
  assert.equal((await digest({ home, now, io })).sent, false);
  row = { ...row, resumeCount: MAX_RESUMES };
  assert.equal(needsDm(row, now), true);
  assert.equal((await digest({ home, now, io })).sent, true);
  assert.match(messages[0], /自動再開を使い切りました。このまま 7 日で閉じます。続けるなら kim が指示してください/);
  assert.equal((await digest({ home, now, io })).sent, false);
  row = { ...row, status: 'done', doneAt: new Date(now).toISOString() };
  assert.equal((await digest({ home, now, io })).sent, true);
  assert.equal((await digest({ home, now: now + WINDOW_MS, io })).sent, false);
  assert.equal(messages.length, 2);
  assert.equal(needsDm({ status: 'open', dueAt: new Date(now - H).toISOString() }, now), true);
});
test('digest: 判断待ちのなしをreasonまたはresumeOutcomeで補い、変更時に再送', async () => {
  const now = Date.now(), home = tmp(), messages = [];
  let row = { sessionId: 'waiting', status: 'waiting_user', promise: '予約', nextKim: 'なし（判断待ち）', reason: 'needs_user: A案かB案を選んでください', ts: new Date(now - H).toISOString() };
  const io = { readLedger: () => [row], notify: async text => { messages.push(text); return { delivered: 'dm' }; } };
  assert.equal(verdictOf(row, now), 'waiting_user'); assert.equal(needsDm(row, now), true);
  assert.equal((await digest({ home, now, io })).sent, true);
  assert.match(messages[0], /kim がすること: A案かB案を選んでください/);
  row = { ...row, reason: '', resumeOutcome: `needs_user: ${'判断'.repeat(50)}` };
  assert.equal((await digest({ home, now, io })).sent, true);
  assert.equal(messages[1].split('kim がすること: ')[1], '判断'.repeat(40));
  assert.equal((await digest({ home, now, io })).sent, false);
});

test('watch: resumed のまま上限に達した行も停滞確認後はDM対象にする', async () => {
  const home = tmp(), now = Date.now();
  seed(home, [{ sessionId: 'exhausted', status: 'resumed', resumeCount: MAX_RESUMES, nextKim: 'なし', promise: '資料作成', ts: new Date(now - 3 * H).toISOString(), cwd: home }]);
  const result = await watch({ home, now, io: noEvidenceIo({ resume: () => assert.fail('resume') }) });
  assert.equal(result.resumed, 0);
  const row = readLedger(ledgerFile(home))[0];
  assert.equal(verdictOf(row, now), 'stalled'); assert.equal(needsDm(row, now), true);
});
