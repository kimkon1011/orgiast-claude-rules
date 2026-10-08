import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeKnowledge, enqueueTodos, selectTargets, runNightly, readJsonl, promotionFile, deferralLedgerFile, deferralTodo, deferralDetectorFile } from './handoff-audit-nightly.mjs';
import { parseHandoff } from './auto-session.mjs';
const detectorSource = fs.readFileSync(new URL('./permanent-fix-deferral-scan.mjs', import.meta.url), 'utf8');
const cloneHome = t => {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, '.audit-detector-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};
const writeClone = (home, text) => {
  const dir = path.join(home, 'clone', 'tools'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'permanent-fix-deferral-scan.mjs'), text);
  return { ORGIAST_NIGHTLY_REPO: path.join(home, 'clone') };
};
const item = { pattern: 'API 確認', route: 'gh api', confidence: 'high' };
test('promotionFileはhome配下のgit管理外台帳を返す', () => {
  assert.equal(promotionFile('/example/home'), path.join('/example/home', '.claude', 'handoff-audit-promotions.jsonl'));
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
test('夜間実行: candidates永続化・別応答で昇格・再実行冪等・未知経路排除', async t => {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, '.audit-nightly-test-'));
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
  assert.equal(result.promoted, 1);
  const promotions = readJsonl(promotionFile(home));
  assert.equal(promotions.length, 2);
  assert.equal(promotions[1].route, item.route);
  assert.equal(promotions[1].source, `handoff-audit-nightly:${promotions[1].observation}`);
  assert.ok(Number.isFinite(Date.parse(promotions[1].ts)));
  const persisted = fs.readFileSync(promotionFile(home), 'utf8');
  assert.ok(persisted.startsWith(existing));
  assert.equal(result.added, 1); assert.equal(result.reviewed, 2);
  assert.equal(readJsonl(path.join(dir, 'handoff-audit-candidates.jsonl')).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(knowledgeFile))[0].confidence, 'high');
  assert.match(fs.readFileSync(path.join(dir, 'next-session.md'), 'utf8'), /gh api/);
  assert.equal((await runNightly(options)).reviewed, 0);
  fs.writeFileSync(knowledgeFile, '[]'); // bootstrapのreset相当でも台帳は残る。
  assert.equal((await runNightly(options)).promoted, 0);
  assert.equal(fs.readFileSync(promotionFile(home), 'utf8'), persisted);
});
function deferralHome(t, lines = []) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, '.audit-nightly-test-'));
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
