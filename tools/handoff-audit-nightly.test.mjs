import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mergeKnowledge, enqueueTodos, selectTargets, runNightly, readJsonl, promotionFile, deferralLedgerFile, deferralTodo, deferralDetectorFile, pruneReviewedCandidates, dequeueToolRouteReview, reviewedCandidatesFile, selectDeferralEnqueueRows } from './handoff-audit-nightly.mjs';
import { parseHandoff } from './auto-session.mjs';
import { isToolNameRoute, enqueueToolRouteReview } from './handoff-audit-nightly.mjs';
const detectorSource = fs.readFileSync(new URL('./permanent-fix-deferral-scan.mjs', import.meta.url), 'utf8');
// tools/ の横断ガードと並列実行しても、一時クローンを走査させない。
const cloneHome = t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-detector-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};
const writeClone = (home, text) => {
  const dir = path.join(home, 'clone', 'tools'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'permanent-fix-deferral-scan.mjs'), text);
  return { ORGIAST_NIGHTLY_REPO: path.join(home, 'clone') };
};
const item = { pattern: 'API 確認', route: 'gh api', confidence: 'high' };
test('knowledge.json の全 route は automation-routes の値（道具名）だけになっていない', () => {
  const knowledge = JSON.parse(fs.readFileSync(new URL('./handoff-audit-knowledge.json', import.meta.url), 'utf8'));
  const routes = JSON.parse(fs.readFileSync(new URL('./automation-routes.json', import.meta.url), 'utf8'));
  for (const entry of knowledge) assert.equal(isToolNameRoute(entry.route, Object.values(routes).flat()), false, entry.pattern);
});
test('mergeKnowledge は道具名 route を confidence high でも昇格せず reason=tool-name-route で候補に保留する', () => {
  const merged = mergeKnowledge([], [item], [], 'one', ['ｇｈ　 api ']);
  assert.deepEqual(merged.knowledge, []);
  assert.deepEqual(merged.promoted, []);
  assert.deepEqual(merged.candidates, [{ ...item, observation: 'one', reason: 'tool-name-route' }]);
  assert.equal(isToolNameRoute('GH API', ['gh api']), false);
  assert.equal(isToolNameRoute('gh api で確認する', ['gh api']), false);
  assert.equal(isToolNameRoute('gh api'), false);
});
test('mergeKnowledge は自己言及パターン（tool-name-route の〜）を候補に積まず捨てる', () => {
  const meta = { pattern: 'tool-name-route の棄却', route: 'gh secret', confidence: 'high' };
  const merged = mergeKnowledge([], [meta], [], 'one', ['gh secret']);
  assert.deepEqual(merged.knowledge, []);
  assert.deepEqual(merged.promoted, []);
  assert.deepEqual(merged.candidates, []);
  const again = mergeKnowledge([], [{ ...meta, pattern: 'tool-name-route の採用', route: 'gh api' }], [], 'two', ['gh api']);
  assert.deepEqual(again.candidates, []);
});
test('道具名 route は前回観測(prior)があっても昇格しない', () => {
  const medium = { ...item, confidence: 'medium' };
  const prior = { ...medium, observation: 'one' };
  const merged = mergeKnowledge([], [medium], [prior], 'two', ['gh api']);
  assert.deepEqual(merged.knowledge, []);
  assert.deepEqual(merged.promoted, []);
  assert.deepEqual(merged.candidates, [prior, { ...medium, observation: 'two', reason: 'tool-name-route' }]);
});
test('道具名 route の同一観測は候補に重複して積まない', () => {
  const first = mergeKnowledge([], [item, item], [], 'one', ['gh api']);
  assert.equal(first.candidates.length, 1);
  const again = mergeKnowledge([], [{ ...item, pattern: 'ＡＰＩ　確認 ', route: 'ｇｈ　 api ' }], first.candidates, 'one', ['gh api']);
  assert.deepEqual(again, first);
});
test('夜間実行: 道具名 route は knowledge を書き換えず、監査TODOでなく見直しTODOを1本だけ積む', async t => {
  const filed = deferralHome(t, [{ ts: new Date(2026, 8, 11, 10).toISOString(), sessionId: 'tool-route', verdict: 'pass', fired: true, evidence: { text: '[手渡し判定]', tools: [] } }]);
  const learned = { pattern: 'PR の作成を user に返す', route: 'gh pr create', confidence: 'high' };
  const nextFile = path.join(filed.dir, 'next-session.md');
  const previous = '## 残TODO\n1. 既存作業\n';
  fs.writeFileSync(nextFile, previous);
  const before = fs.readFileSync(filed.knowledgeFile, 'utf8');
  const result = await runNightly({ ...filed.options, ask: async () => ({ verdict: 'pass', violations: [], learned: [learned] }) });
  assert.equal(result.reviewed, 1);
  assert.equal(result.promoted, 0);
  assert.equal(result.added, 0);
  assert.equal(fs.readFileSync(filed.knowledgeFile, 'utf8'), before);
  const todos = parseHandoff(fs.readFileSync(nextFile, 'utf8')).todos;
  assert.equal(todos.filter(x => x.includes('[handoff-audit:tool-name-route]')).length, 1);
  assert.ok(!todos.some(x => x.includes('再発防止の経路: gh pr create')), '道具名 route の監査TODOは積まない');
  assert.equal(enqueueToolRouteReview(fs.readFileSync(nextFile, 'utf8'), 3), fs.readFileSync(nextFile, 'utf8'), '見直しTODOは重複させない');
  assert.equal(enqueueToolRouteReview(previous, 0), previous);
  assert.deepEqual(readJsonl(promotionFile(filed.home)), []);
  const candidates = readJsonl(path.join(filed.dir, 'handoff-audit-candidates.jsonl'));
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], { ...learned, observation: candidates[0].observation, reason: 'tool-name-route' });
  assert.ok(candidates[0].observation);
});
test('promotionFileはhome配下のgit管理外台帳を返す', () => {
  assert.equal(promotionFile('/example/home'), path.join('/example/home', '.claude', 'handoff-audit-promotions.jsonl'));
});
test('同一route・別patternは昇格しない（rescue枝の量産源を断つ）', () => {
  const known = [{ pattern: '既存の確認', route: 'gh api', confidence: 'high', source: 'manual' }];
  const merged = mergeKnowledge(known, [{ pattern: '別ラベルの確認', route: 'ｇｈ　 api ', confidence: 'high' }], [], 'obs');
  assert.equal(merged.knowledge.length, 1);
  assert.equal(merged.promoted.length, 0);
  const medium = mergeKnowledge(known, [{ pattern: '別ラベルの確認', route: 'gh api', confidence: 'medium' }], [], 'obs');
  assert.equal(medium.candidates.length, 0);
});
test('patternキーで重複排除、mediumは候補、別観測でhighへ', () => {
  const first = mergeKnowledge([], [item, item], [], 'one');
  assert.equal(first.knowledge.length, 1);
  const medium = { ...item, confidence: 'medium' };
  const candidate = mergeKnowledge([], [medium, medium], [], 'one');
  assert.equal(candidate.knowledge.length, 0); assert.equal(candidate.candidates.length, 1);
  assert.equal(mergeKnowledge([], [medium], candidate.candidates, 'one').knowledge.length, 0);
  assert.equal(mergeKnowledge([], [medium], candidate.candidates, 'two').knowledge[0].confidence, 'high');
  assert.equal(mergeKnowledge([], [{ ...medium, route: 'different' }], candidate.candidates, 'two').knowledge.length, 0);
});
test('残TODO書式はauto-sessionで読める・既存本文保持・重複防止', () => {
  const before = '<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 既存作業\n\n## その他\n保持\n';
  const after = enqueueTodos(before, [item]);
  assert.ok(after.includes('1. 既存作業\n\n## その他\n保持\n'));
  assert.equal(parseHandoff(after).todos.length, 2);
  assert.match(parseHandoff(after).todos[0], /gh api/);
  assert.equal(enqueueTodos(after, [item]), after);
  assert.equal(parseHandoff(enqueueTodos('', [item])).todos.length, 1);
});
test('knowledgeに記録済みのrouteは抑制し、新規routeは追加する', () => {
  assert.equal(parseHandoff(enqueueTodos('', [item], ['gh api'])).todos.length, 0);
  assert.equal(parseHandoff(enqueueTodos('', [item], ['ｇｈ　 api'])).todos.length, 0);
  assert.equal(parseHandoff(enqueueTodos('', [{ ...item, route: 'codex-do.mjs' }], ['gh api'])).todos.length, 1);
});
test('同一route・別patternは1行だけ追加し、新書式の既存routeも正規化して重複防止', () => {
  const after = enqueueTodos('', [item, { ...item, pattern: '別のAPI確認' }]);
  assert.equal(parseHandoff(after).todos.length, 1);
  assert.equal(enqueueTodos(after, [{ pattern: 'さらに別の確認', route: 'ｇｈ　 api' }]), after);
});
test('旧書式の既存routeも正規化して重複防止、別routeは追加', () => {
  const before = '## 残TODO\n1. [handoff-audit:0123456789abcdef] 以前の確認: ｇｈ　 api を既存権限で調査・検証し結果を記録する。送信・権限変更は既存の承認範囲を守る。kimへのDMなし。\n';
  assert.equal(enqueueTodos(before, [item]), before);
  const after = enqueueTodos(before, [{ ...item, route: 'codex-do.mjs' }]);
  assert.equal(parseHandoff(after).todos.length, 2);
  assert.ok(after.includes(before.split('\n')[1]));
});
test('生成行はpatternを検証対象、routeを手段として含み、改行を潰し制約文を保持', () => {
  const after = enqueueTodos('', [{ pattern: 'API\r\n確認', route: 'gh\napi' }]);
  const todos = parseHandoff(after).todos;
  assert.equal(todos.length, 1);
  assert.match(todos[0], /^\[handoff-audit:[a-f0-9]{16}\] API 確認 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: gh api）。送信・権限変更は既存の承認範囲を守る。kimへのDMなし。$/);
});
test('前日passとretry-cap/blocked後passを選ぶ、当日は除外', () => {
  const since = Date.parse('2026-09-11T00:00:00Z'), until = since + 86400000;
  const row = { ts: '2026-09-11T10:00:00Z', sessionId: 'a', fired: true, verdict: 'pass', evidence: { text: 'Gmail 下書き', tools: [] } };
  const targets = selectTargets([row, { ...row, ts: '2026-09-12T00:00:00Z' }, { ...row, skipped: 'regex-blocked' }], [
    { ...row, sessionId: 'b', verdict: 'block' }, { ...row, sessionId: 'b', verdict: 'pass', auditEvidence: row.evidence },
    { ...row, sessionId: 'c', verdict: 'retry-cap', auditEvidence: row.evidence }], since, until);
  assert.equal(targets.length, 3);
});
// 監査は route を knowledge か automation-routes から「そのまま引用」させる。knowledge 側の route は一意性ガードで、
// automation-routes 側は道具名ガードで昇格しないため、夜間実行は候補の保留だけを行い knowledge を書き換えない。
test('夜間実行: candidates永続化・道具名は2観測でも昇格しない・再実行冪等・未知経路排除', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-nightly-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const knowledgeFile = path.join(home, 'knowledge.json'); fs.writeFileSync(knowledgeFile, '[]');
  const now = new Date(2026, 8, 12, 10), yesterday = new Date(2026, 8, 11, 10).toISOString();
  const rows = ['a', 'b'].map(sessionId => ({ ts: yesterday, sessionId, verdict: 'pass', fired: true, evidence: { text: '[手渡し判定]', tools: [] } }));
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'), rows.map(JSON.stringify).join('\n'));
  const options = { home, now, knowledgeFile, ask: async () => ({ verdict: 'block', violations: [{ rule: 2, quote: '依頼', fix: 'gh api' }], learned: [{ ...item, confidence: 'medium' }, { pattern: '架空', route: 'invented', confidence: 'high' }] }) };
  const existing = JSON.stringify({ pattern: '既存', route: '保持' }) + '\n';
  fs.writeFileSync(promotionFile(home), existing);
  const result = await runNightly(options);
  assert.equal(result.promoted, 0);
  const persisted = fs.readFileSync(promotionFile(home), 'utf8');
  assert.equal(persisted, existing);
  assert.equal(result.added, 0); assert.equal(result.reviewed, 2);
  const held = readJsonl(path.join(dir, 'handoff-audit-candidates.jsonl'));
  assert.equal(held.length, 2, '別観測ごとに保留し、未知経路(invented)は積まない');
  assert.ok(held.every(c => c.route === item.route && c.reason === 'tool-name-route'));
  assert.equal(fs.readFileSync(knowledgeFile, 'utf8'), '[]');
  const todos = parseHandoff(fs.readFileSync(path.join(dir, 'next-session.md'), 'utf8')).todos;
  assert.equal(todos.length, 1); assert.match(todos[0], /tool-name-route/);
  assert.equal((await runNightly(options)).reviewed, 0);
  fs.writeFileSync(knowledgeFile, '[]'); // bootstrapのreset相当でも台帳は残る。
  assert.equal((await runNightly(options)).promoted, 0);
  assert.equal(fs.readFileSync(promotionFile(home), 'utf8'), persisted);
});
function deferralHome(t, lines = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-nightly-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  const knowledgeFile = path.join(home, 'knowledge.json'); fs.writeFileSync(knowledgeFile, '[]');
  if (lines.length) fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'), lines.map(JSON.stringify).join('\n'));
  return { home, dir, knowledgeFile, options: { home, now: new Date(2026, 8, 12, 10), knowledgeFile, ask: async () => ({ verdict: 'pass', violations: [], learned: [] }) } };
}
test('先送り文を検出すると原文とセッションID入りのTODOを積み、台帳に窓と実測行を残す', async t => {
  const quote = '恒久修正は次セッションで行う';
  const ts = new Date(2026, 8, 11, 10).toISOString();
  const filed = deferralHome(t, [{ ts, sessionId: 'deadbeefcafe', verdict: 'pass', fired: false, excerpt: quote, violations: [{ quote }] }]);
  const result = await runNightly(filed.options);
  const handoff = fs.readFileSync(path.join(filed.dir, 'next-session.md'), 'utf8');
  assert.ok(handoff.includes(quote));
  assert.ok(handoff.includes('deadbeef'));
  assert.equal(result.deferral.hits, 1);
  assert.equal(result.deferral.total, 1);
  assert.equal(result.deferral.byPattern.P1, 1);
  assert.equal(result.deferral.enqueued, 1);
  assert.equal(result.deferral.error, undefined);
  const ledger = readJsonl(deferralLedgerFile(filed.home));
  assert.equal(ledger.filter(r => r.kind === 'window').length, 1);
  const hits = ledger.filter(r => r.kind === 'hit');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'handoff-audit-ledger.jsonl');
  assert.equal(hits[0].match, quote);
});
test('同じ窓で再実行してもTODOは増えず、窓の実測行だけが積まれる', async t => {
  const quote = '恒久修正は次セッションで行う';
  const ts = new Date(2026, 8, 11, 10).toISOString();
  const filed = deferralHome(t, [{ ts, sessionId: 'deadbeefcafe', verdict: 'pass', fired: false, excerpt: quote, violations: [{ quote }] }]);
  await runNightly(filed.options);
  const before = fs.readFileSync(path.join(filed.dir, 'next-session.md'), 'utf8');
  assert.equal(parseHandoff(before).todos.length, 1);
  const second = await runNightly(filed.options);
  assert.equal(fs.readFileSync(path.join(filed.dir, 'next-session.md'), 'utf8'), before);
  assert.equal(second.deferral.enqueued, 0);
  const ledger = readJsonl(deferralLedgerFile(filed.home));
  assert.equal(ledger.filter(r => r.kind === 'hit').length, 1);
  assert.equal(ledger.filter(r => r.kind === 'window').length, 2);
});
// 1つの先送りが同一セッションで繰り返し検出されると、検出行ごとに別IDのTODOが積まれ、
// 「検証の検証」セッションが検出行数だけ増殖する（2026-10-23T07:23 の 9310953f は4行＝4本）。
// 台帳の検出行は全部残したまま、TODOは (sessionId, pattern) ごとに1本へ畳む。
test('同一セッションの同じパターンが窓内で複数検出されても監査TODOは1本にまとめる', async t => {
  const quote = '恒久修正は次セッションで行う';
  const ts = new Date(2026, 8, 11, 10).toISOString();
  const second = `${quote}（2回目）`;
  const filed = deferralHome(t, [
    { ts, sessionId: 'deadbeefcafe', verdict: 'pass', fired: false, excerpt: quote, violations: [{ quote }] },
    { ts: new Date(2026, 8, 11, 10, 0, 5).toISOString(), sessionId: 'deadbeefcafe', verdict: 'pass', fired: false, excerpt: second, violations: [{ quote: second }] },
    { ts: new Date(2026, 8, 11, 10, 0, 9).toISOString(), sessionId: 'feedfacecafe', verdict: 'pass', fired: false, excerpt: quote, violations: [{ quote }] }
  ]);
  const result = await runNightly(filed.options);
  assert.equal(result.deferral.hits, 3);
  assert.equal(result.deferral.enqueued, 2);
  const handoff = fs.readFileSync(path.join(filed.dir, 'next-session.md'), 'utf8');
  assert.equal(parseHandoff(handoff).todos.length, 2);
  assert.equal(readJsonl(deferralLedgerFile(filed.home)).filter(r => r.kind === 'hit').length, 3);
});
test('selectDeferralEnqueueRows は in-session 解消済み行を除外する', () => {
  assert.deepEqual(selectDeferralEnqueueRows([{ sessionId: 'one', pattern: 'P1', resolved: 'in-session' }]), []);
});
test('selectDeferralEnqueueRows は cross-session 解消済み行を除外する', () => {
  assert.deepEqual(selectDeferralEnqueueRows([{ sessionId: 'one', pattern: 'P1', resolved: 'cross-session' }]), []);
});
test('selectDeferralEnqueueRows は未解消行を残す', () => {
  const row = { sessionId: 'one', pattern: 'P1' };
  assert.deepEqual(selectDeferralEnqueueRows([row]), [row]);
});
test('selectDeferralEnqueueRows は同じ sessionId と pattern の先頭だけを残す', () => {
  const first = { sessionId: 'one', pattern: 'P1', match: 'first' };
  const second = { sessionId: 'one', pattern: 'P1', match: 'second' };
  assert.deepEqual(selectDeferralEnqueueRows([first, second]), [first]);
});
test('selectDeferralEnqueueRows は同じ sessionId でも異なる pattern を残す', () => {
  const rows = [{ sessionId: 'one', pattern: 'P1' }, { sessionId: 'one', pattern: 'P2' }];
  assert.deepEqual(selectDeferralEnqueueRows(rows), rows);
});
test('selectDeferralEnqueueRows は undefined を空配列として扱う', () => {
  assert.deepEqual(selectDeferralEnqueueRows(undefined), []);
});
test('selectDeferralEnqueueRows は実データ由来の resolved 行だけを除外する', () => {
  const rows = [
    { ts: '2026-11-24T12:15:07.636Z', sessionId: '114ccd64-b1a9-44e0-8a9f-8d100d915a76', pattern: 'W', match: '92 次に kim がすること: なし この後の自動進行: PR #2692 の CI 完了を待ち', verdict: 'pass', resolved: 'in-session' },
    { ts: '2026-11-23T15:46:55.952Z', sessionId: '05c63b55-7b5f-44b5-87fd-9f3aaed4e8a6', pattern: 'W', match: '2本目（PR #2651）ができました。', verdict: 'pass', resolved: 'cross-session', resolvedBy: '7e068083-729c-4076-9886-9c7cf6984d4e', identifier: 'pr:2651' },
    { ts: '2026-11-24T11:38:20.140Z', sessionId: 'fda85b19-50be-48f9-b1fe-263cdceb1074', pattern: 'P2', match: 'BLOCKED は 53件のまま', verdict: 'pass' }
  ];
  assert.deepEqual(selectDeferralEnqueueRows(rows), [rows[2]]);
});
test('先送り文が無い窓でも hits:0 の実測行を残す', async t => {
  const filed = deferralHome(t, [{ ts: new Date(2026, 8, 11, 10).toISOString(), sessionId: 'feedface', verdict: 'pass', fired: false, excerpt: '修正が完了しました' }]);
  const result = await runNightly(filed.options);
  assert.equal(result.deferral.hits, 0);
  assert.equal(result.deferral.enqueued, 0);
  const windows = readJsonl(deferralLedgerFile(filed.home)).filter(r => r.kind === 'window');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].hits, 0);
  assert.equal(windows[0].total, 1);
  assert.equal(fs.existsSync(path.join(filed.dir, 'next-session.md')), false);
});
test('deferralTodoのpatternは実例を80文字で切って含む', () => {
  const todo = deferralTodo({ ts: '2026-09-26T00:00:00Z', sessionId: 'abcdefgh12345678', pattern: 'P2', match: 'あ'.repeat(200) });
  assert.ok(todo.pattern.includes('あ'.repeat(80)));
  assert.ok(!todo.pattern.includes('あ'.repeat(81)));
  assert.equal(todo.pattern, `恒久修正の先送り文を検出（2026-09-26T00:00:00Z / abcdefgh / P2）「${'あ'.repeat(80)}」`);
  assert.match(todo.route, /abcdefgh12345678/);
});
// route が重複すると enqueueTodos の重複スキップに掛かり、同じ route を持つ pattern の
// うち片方の監査TODOが黙って落ちる（2026-09-25 に「外部サービスの課金・購入画面の操作」が
// 「社内・グループ会社・スタッフ宛の連絡文」の route を流用して実際に発生）。
test('knowledge.json の route は enqueueTodos と同じ正規化で一意', () => {
  const knowledge = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'handoff-audit-knowledge.json'), 'utf8'));
  const normalize = value => String(value).normalize('NFKC').trim().replace(/\s+/g, ' ');
  const seen = new Map();
  for (const entry of knowledge) {
    const route = normalize(entry.route);
    assert.notEqual(route, '', `route が空: ${entry.pattern}`);
    assert.ok(!seen.has(route),
      `route が重複: 「${entry.pattern}」と「${seen.get(route)}」 → 片方の監査TODOが追加されない\n${route.slice(0, 120)}`);
    seen.set(route, entry.pattern);
  }
});
test('先送り検出器: クローンが同じ本文（改行コード差のみ）なら同梱コピーを使う', t => {
  const home = cloneHome(t);
  const env = writeClone(home, detectorSource.replace(/\n/g, '\r\n'));
  const picked = deferralDetectorFile(home, env);
  assert.equal(picked.source, 'local');
  assert.equal(picked.differs, false);
  assert.equal(fs.readFileSync(picked.file, 'utf8'), detectorSource);
});
test('先送り検出器: クローンの本文が違えば新しい方（クローン）を使う', t => {
  const home = cloneHome(t);
  const env = writeClone(home, detectorSource + '\n// 修正済み\n');
  const picked = deferralDetectorFile(home, env);
  assert.equal(picked.source, 'clone');
  assert.equal(picked.differs, true);
  assert.equal(picked.file, path.join(home, 'clone', 'tools', 'permanent-fix-deferral-scan.mjs'));
});
test('先送り検出器: クローンが無ければ同梱コピーへ落ちて例外を投げない', t => {
  const home = cloneHome(t);
  const picked = deferralDetectorFile(home, { ORGIAST_NIGHTLY_REPO: path.join(home, 'missing') });
  assert.equal(picked.source, 'local');
  assert.equal(picked.differs, false);
});
test('先送り検出器: クローンが違っても読めないときは runNightly が同梱コピーで完走する', async t => {
  const quote = '恒久修正は次セッションで行う';
  const ts = new Date(2026, 8, 11, 10).toISOString();
  const filed = deferralHome(t, [{ ts, sessionId: 'deadbeefcafe', verdict: 'pass', fired: false, excerpt: quote, violations: [{ quote }] }]);
  // 中身が壊れた検出器をクローン側に置く（import はできるが scan が無い）。
  const env = writeClone(filed.home, 'export const nothing = 1;\n');
  const result = await runNightly({ ...filed.options, env });
  assert.equal(result.deferral.error, undefined);
  assert.equal(result.deferral.hits, 1);
  assert.equal(result.deferral.detector, 'local');
  assert.equal(result.deferral.detectorDiffers, true);
  assert.equal(result.deferral.enqueued, 1);
  assert.equal(readJsonl(deferralLedgerFile(filed.home)).filter(r => r.kind === 'window')[0].detector, 'local');
});
test('先送り検出器: クローンが読めるならクローンの検出器で走り、窓に clone と残る', async t => {
  const quote = 'クローン側だけが検出する ZZZ特殊パターン';
  const ts = new Date(2026, 8, 11, 10).toISOString();
  const filed = deferralHome(t, [{ ts, sessionId: 'clone0001', verdict: 'pass', fired: false, excerpt: quote, violations: [{ quote }] }]);
  const dir = path.join(filed.home, 'clone', 'tools'); fs.mkdirSync(dir, { recursive: true });
  // クローン側だけが持つパターンを1つ足した検出器を置く（実物と同じく兄弟モジュールも置く）。
  fs.writeFileSync(path.join(dir, 'permanent-fix-deferral-scan.mjs'), `${detectorSource}\nPATTERNS.__verify__ = /ZZZ特殊パターン/;\n`);
  fs.copyFileSync(new URL('./is-entry.mjs', import.meta.url), path.join(dir, 'is-entry.mjs'));
  const result = await runNightly({ ...filed.options, env: { ORGIAST_NIGHTLY_REPO: path.join(filed.home, 'clone') } });
  assert.equal(result.deferral.error, undefined);
  assert.equal(result.deferral.detector, 'clone');
  assert.equal(result.deferral.detectorDiffers, true);
  assert.equal(result.deferral.byPattern.__verify__, 1);
  assert.equal(result.deferral.enqueued, 1);
  const window = readJsonl(deferralLedgerFile(filed.home)).filter(r => r.kind === 'window')[0];
  assert.equal(window.detector, 'clone');
  assert.equal(window.hits, 1);
});
// ── reviewed-candidates 台帳関連 ──────────────────────────────────────────
test('pruneReviewedCandidates: reviewed 台帳にある候補が除かれ、他は残る', () => {
  const candidates = [
    { observation: 'a', pattern: 'API確認', route: 'gh api', reason: 'tool-name-route' },
    { observation: 'b', pattern: 'PR作成', route: 'gh pr create', reason: 'tool-name-route' },
    { observation: 'c', pattern: 'ログ調査', route: 'gh log' },
  ];
  const knowledge = [{ pattern: '既存知識', route: 'gh known', confidence: 'high' }];
  const reviewedRows = [
    { observation: 'a', pattern: 'API確認', route: 'gh api', decision: 'adopted', ref: 'PR#1' },
  ];
  const result = pruneReviewedCandidates(candidates, knowledge, reviewedRows);
  assert.equal(result.kept.length, 2);
  assert.equal(result.pruned.length, 1);
  assert.equal(result.pruned[0].pattern, 'API確認');
  assert.equal(result.pruned[0].decision, undefined); // review match → no decision override
  assert.ok(result.kept.some(c => c.pattern === 'PR作成'));
  assert.ok(result.kept.some(c => c.pattern === 'ログ調査'));
});
test('pruneReviewedCandidates: knowledge と pattern 一致の候補は auto-pruned になる', () => {
  const candidates = [
    { observation: 'x', pattern: 'API確認', route: 'gh api' },
    { observation: 'y', pattern: 'ルート重複', route: 'gh check' },
  ];
  const knowledge = [
    { pattern: 'API確認', route: 'gh api', confidence: 'high' },  // pattern match
  ];
  const result = pruneReviewedCandidates(candidates, knowledge, []);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].pattern, 'ルート重複');
  assert.equal(result.pruned.length, 1);
  assert.equal(result.pruned[0].decision, 'auto-pruned');
});
test('pruneReviewedCandidates: reviewed も knowledge も一致しない候補は全て残る', () => {
  const candidates = [
    { observation: 'a', pattern: '独自パターン', route: 'custom' },
  ];
  const result = pruneReviewedCandidates(candidates, [], []);
  assert.equal(result.kept.length, 1);
  assert.equal(result.pruned.length, 0);
});
test('mergeKnowledge: reviewed 済みの候補は再度積まれない', () => {
  const reviewed = [{ observation: 'obs1', pattern: 'API確認', route: 'gh api', decision: 'rejected', ref: 'PR#1' }];
  const merged = mergeKnowledge([], [{ pattern: 'API確認', route: 'gh api', confidence: 'high' }], [], 'obs1', [], reviewed);
  assert.equal(merged.knowledge.length, 0);
  assert.equal(merged.candidates.length, 0);
  assert.equal(merged.promoted.length, 0);
});
test('mergeKnowledge: reviewed にない候補は通常通り積まれる（reviewed 引数互換）', () => {
  const merged = mergeKnowledge([], [{ pattern: '新パターン', route: 'gh new', confidence: 'high' }], [], 'obs1', [], [{ observation: '他のobs', pattern: '別パターン', route: 'gh other', decision: 'adopted' }]);
  assert.equal(merged.knowledge.length, 1);
  assert.equal(merged.knowledge[0].pattern, '新パターン');
});
test('dequeueToolRouteReview: TODO 行とその直後の空行を削除する', () => {
  const before = '## 残TODO\n1. [handoff-audit:tool-name-route] 見直しTODO本文\n\n2. [handoff-audit:abc] 他のTODO\n\n## その他\n保持\n';
  const after = dequeueToolRouteReview(before);
  assert.equal(after, '## 残TODO\n2. [handoff-audit:abc] 他のTODO\n\n## その他\n保持\n');
  assert.ok(!after.includes('tool-name-route'));
  assert.ok(after.includes('他のTODO'));
  assert.ok(after.includes('## その他'));
});
test('dequeueToolRouteReview: TODO が無ければ同一文字列を返す', () => {
  const input = '## 残TODO\n1. [handoff-audit:abc] 他のTODO\n\n## その他\n';
  assert.equal(dequeueToolRouteReview(input), input);
});
test('dequeueToolRouteReview: 空文字列でも壊れない', () => {
  assert.equal(dequeueToolRouteReview(''), '');
});
test('dequeueToolRouteReview: 番号が振り直されていても tool-name-route の行だけ消える', () => {
  const before = '## 残TODO\n18. foo\n19. [handoff-audit:tool-name-route] bar\n20. baz\n\n## その他\n';
  const after = dequeueToolRouteReview(before);
  assert.equal(after, '## 残TODO\n18. foo\n20. baz\n\n## その他\n');
  assert.ok(!after.includes('tool-name-route'));
  assert.ok(after.includes('18. foo'));
  assert.ok(after.includes('20. baz'));
});
test('--mark-reviewed: 一時 home で candidates を台帳へ移し、TODO を消す', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-mark-reviewed-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir, { recursive: true });
  const nextFile = path.join(dir, 'next-session.md');
  const candidateFile = path.join(dir, 'handoff-audit-candidates.jsonl');
  // candidates: 3件（reason=tool-name-route 2件 + 通常1件）
  const candidates = [
    { observation: 'a', pattern: 'API確認', route: 'gh api', reason: 'tool-name-route' },
    { observation: 'b', pattern: 'PR作成', route: 'gh pr create', reason: 'tool-name-route' },
    { observation: 'c', pattern: 'ログ調査', route: 'gh log' },
  ];
  fs.writeFileSync(candidateFile, candidates.map(JSON.stringify).join('\n') + '\n');
  // next-session.md に TODO がある状態
  const nextContent = '## 残TODO\n1. [handoff-audit:tool-name-route] 見直しTODO\n\n2. [handoff-audit:abc] 他のTODO\n\n';
  fs.writeFileSync(nextFile, nextContent);
  // 実行
  const { execFileSync } = await import('node:child_process');
  const script = fileURLToPath(new URL('./handoff-audit-nightly.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [script, '--mark-reviewed', '--ref', 'PR#test', '--home', home], { encoding: 'utf8' });
  const result = JSON.parse(out.trim());
  assert.equal(result.moved, 2);
  // candidates から tool-name-route が除去されている
  const remaining = readJsonl(candidateFile);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].pattern, 'ログ調査');
  // reviewed 台帳に3行（auto-pruned は無いので通常の2件のみ）
  const reviewedFile = reviewedCandidatesFile(home);
  const reviewed = readJsonl(reviewedFile);
  assert.equal(reviewed.length, 2);
  assert.ok(reviewed.every(r => r.ref === 'PR#test'));
  assert.equal(reviewed.filter(r => r.pattern === 'API確認').length, 1);
  assert.equal(reviewed.filter(r => r.pattern === 'PR作成').length, 1);
  // TODO が消えている
  const afterNext = fs.readFileSync(nextFile, 'utf8');
  assert.ok(!afterNext.includes('tool-name-route'));
  assert.ok(afterNext.includes('[handoff-audit:abc]'));
});
