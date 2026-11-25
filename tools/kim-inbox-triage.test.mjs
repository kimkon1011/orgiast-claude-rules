import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyItems, collectEvidence, extractReferences } from './kim-inbox-triage.mjs';

const item = (id, text, createdAt = '2026-11-20T00:00:00.000Z') => ({ id, text, createdAt, kind: 'ask', status: 'open' });

test('MERGED PR and absent branch are A with measured evidence', async () => {
  const items = [item('ki-20261120000000-0001', 'PR #2504 をマージしてよい？'), item('ki-20261120000000-0002', 'rescue/x を削除してよい？')];
  const evidence = await collectEvidence(items, {
    checkPr: async ref => ({ number: ref.number, state: 'MERGED', url: 'https://github.test/pull/2504' }),
    checkBranch: async () => ({ exists: false }),
  });
  const result = classifyItems(items, evidence);
  assert.deepEqual(result.items.map(row => row.classification), ['A', 'A']);
  assert.match(result.items[0].reason, /MERGED/);
  assert.match(result.items[1].reason, /origin に存在しない/);
});

test('same older ask is A and newer ask remains conservatively classified', () => {
  const items = [item('ki-20261120000000-0001', '設定を承認しますか', '2026-11-20T00:00:00Z'), item('ki-20261121000000-0002', '設定を承認しますか', '2026-11-21T00:00:00Z')];
  const result = classifyItems(items);
  assert.equal(result.items[0].classification, 'A');
  assert.notEqual(result.items[1].classification, 'A');
});

test('same decision patterns become B groups and unrelated ask becomes C', () => {
  const items = [item('ki-20261120000000-0001', 'rescue/a を破棄してよい？'), item('ki-20261120000000-0002', 'rescue/b を残す？'), item('ki-20261120000000-0003', '契約金額を決めてください')];
  const result = classifyItems(items);
  assert.deepEqual(result.items.map(row => row.classification), ['B', 'B', 'C']);
  assert.equal(result.groups[0].count, 2);
  assert.match(result.groups[0].answer, /2件/);
});

test('unmeasured or failed evidence never enters A', async () => {
  const items = [item('ki-20261120000000-0001', 'PR #9999 の状況を判断して')];
  const evidence = await collectEvidence(items, { checkPr: async () => { throw new Error('offline'); }, checkBranch: async () => null });
  assert.notEqual(classifyItems(items, evidence).items[0].classification, 'A');
});

test('source has a read-only guard: no ledger writer import or filesystem mutation call', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, 'kim-inbox-triage.mjs'), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]\.\/kim-inbox\.mjs['"]/);
  assert.doesNotMatch(source, /\b(?:writeFile|writeFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync)\s*\(/);
  assert.doesNotMatch(source, /--(?:answer|seen|drop|add|merge-into|dedupe-existing|auto-close)\b/);
});

test('extractReferences preserves explicit repo and branch names', () => {
  const refs = extractReferences('https://github.com/acme/repo/pull/12 と rescue/keep-me を確認');
  assert.deepEqual(refs.prs, [{ number: 12, repo: 'acme/repo' }]);
  assert.deepEqual(refs.branches, ['rescue/keep-me']);
});
