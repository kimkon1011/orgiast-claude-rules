import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';
import { main as registerTasks } from './register-auto-progress-task.mjs';
import { extractPromise, extractNextKim, applyPromise, buildRecord, record, readLedger, ledgerFile } from './auto-progress-ledger.mjs';
import { run as watch, parseVerdict, deterministicVerdict, judge, GRACE_MS, postSheet, resumeSession } from './auto-progress-watch.mjs';
import { run as digest, selectRows, formatDigest } from './auto-progress-digest.mjs';
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
  assert.equal(deterministicVerdict({ any: true, lastEvidenceAt: now - H }, now).verdict, 'in_progress');
  assert.equal(deterministicVerdict({ any: true, lastEvidenceAt: now - 8 * H }, now).verdict, 'stalled');
});

test('judge: LLM 全滅(null/例外)なら決定論へ。証拠なしは LLM を呼ばない', () => {
  const now = Date.now();
  const ev = { any: true, lastEvidenceAt: now - 9 * H, transcript: { count: 1, lastAt: now - 9 * H, snippets: [] }, files: { names: [], lastAt: 0 }, runs: { names: [] } };
  const row = { promise: 'p', ts: new Date(now - 10 * H).toISOString() };
  assert.equal(judge(row, ev, now, { askLlm: () => null }).source, 'deterministic');
  assert.equal(judge(row, ev, now, { askLlm: () => { throw new Error('x'); } }).verdict, 'stalled');
  assert.deepEqual(judge(row, ev, now, { askLlm: () => 'done | 完了' }), { verdict: 'done', reason: '完了', source: 'llm' });
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

test('watch: 猶予6時間未満は判定しない', async () => {
  const home = tmp(); const now = Date.now();
  seed(home, [{ sessionId: 's', ts: new Date(now - 5 * H).toISOString(), status: 'open', promise: 'p', cwd: home, pc: 'PC' }]);
  const calls = [];
  const s = await watch({ home, now, io: baseIo({ gatherEvidence: undefined, transcriptEvidence: () => { calls.push(1); return { count: 0, lastAt: 0, snippets: [] }; } }) });
  assert.equal(s.graced, 1); assert.equal(s.checked, 0); assert.equal(calls.length, 0);
  assert.equal(GRACE_MS, 6 * H);
});

test('watch: done は閉じ、stalled は再開1回＋Sheet報告、同日2回目は再開しない', async () => {
  // 実時刻の23時台では now + H が翌日になり、再開が正しく許可される。
  // localDay と同じローカル時刻の正午に固定して、どのTZでも同日を検証する。
  const home = tmp(); const now = new Date(2026, 9, 15, 12).getTime();
  const mk = (id) => ({ sessionId: id, ts: new Date(now - 10 * H).toISOString(), status: 'open', promise: `p-${id}`, cwd: home, pc: 'PC', user: 'u', transcriptPath: '' });
  seed(home, [mk('a'), mk('b')]);
  const posts = []; const resumed = [];
  const io = baseIo({
    transcriptEvidence: () => ({ count: 1, lastAt: now - 8 * H, snippets: ['x'] }), recentFiles: () => ({ lastAt: 0, names: [] }), autoSessionRuns: () => ({ lastAt: 0, names: [] }),
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
    { sessionId: 'k1', pc: 'other-PC', promise: '夜間デプロイ', ts: new Date(now - 30 * H).toISOString(), lastCheckedAt: new Date(now - H).toISOString(), status: 'open' },
  ];
  assert.equal(selectRows(rows, now).length, 1);
  const text = formatDigest(selectRows(rows, now), now, 'other-PC');
  assert.match(text, /^other-PC 自動進行の定期進捗 1件/);
  assert.match(text, /約束: 夜間デプロイ／判定: in_progress/);
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
    readLedger: () => [{ status: 'resumed', promise: 'p', ts: new Date(now - H).toISOString(), resumedAt: new Date(now).toISOString() }],
    notify: async (_text, options) => { assert.equal(options.webhookFallback, false); return { delivered: 'none', reason: 'failed' }; },
  } });
  assert.equal(result.sent, false);
  assert.equal(result.error, 'failed');
});

test('resumeSession: 古い成果JSONは再利用しない', async () => {
  const home = tmp(); fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'auto-progress-resume-session.json'), '{"progressed":true,"evidence":"old"}');
  const result = await resumeSession({ sessionId: 'session', cwd: home, promise: 'p' }, { home, io: { executable: 'mock', runChild: async () => ({ status: 'success' }) } });
  assert.equal(result.outcome, 'no-progress');
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
