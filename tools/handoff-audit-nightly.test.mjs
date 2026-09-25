import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeKnowledge, enqueueTodos, selectTargets, runNightly, readJsonl, promotionFile } from './handoff-audit-nightly.mjs';
import { parseHandoff } from './auto-session.mjs';
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
