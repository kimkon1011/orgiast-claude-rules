import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeIndex, build } from './onboarding-sync.mjs';
import { dedupePreferences } from './claude-md-dedupe.mjs';
import { renderTemplate } from './render-claude-template.mjs';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const source = read('../ONBOARDING.md');
const index = makeIndex(source);
const legacy = JSON.parse(read('./claude-md-legacy.json'));

test('every migrated preference has its complete replacement in the real generated index', () => {
  for (const entry of legacy) {
    for (const rule of entry.requires) assert.ok(index.includes(rule), rule);
    const current = `${entry.text}\n\n## 個人の追記\nkeep exactly\r\n`;
    assert.equal(dedupePreferences(current, index).trim(), '## 個人の追記\nkeep exactly');
    // An older/incomplete ONBOARDING must never authorize removal.
    assert.equal(dedupePreferences(current, ''), current);
    assert.equal(dedupePreferences(current, index.replace(entry.requires[0], '')), current);
  }
});

test('locally modified sections, CRLF and content outside the managed block survive migration', () => {
  const entry = legacy.find(e => e.kind === 'section');
  const customized = entry.text.replace('authuser=', 'authuser=LOCAL-CHANGE-');
  const local = `${customized}\n\n独自の制約\n\n## 別の個人規則\n残す\n`.replaceAll('\n', '\r\n');
  assert.equal(dedupePreferences(local, index), local);
  const before = `${entry.text}\n\n${build(null, 'old index', 'old').updated}\n末尾の個人規則\r\n`;
  const once = build(before, index, 'fixed').updated;
  assert.ok(!once.includes(entry.text));
  assert.ok(once.endsWith('末尾の個人規則\r\n'));
  assert.equal(build(once, index, 'fixed').updated, once);
  assert.equal(once.match(/<!-- BEGIN: オージャスト共通ルール/g).length, 1);
});

test('a first-line absolute rule is emitted once in full, including later sentences', () => {
  const rule = '**🔴 必須の前半。削除してはいけない具体値。**';
  const output = makeIndex(`### 1.1 見出し\n\n${rule}\n`);
  assert.equal(output.split('\n').filter(l => l.includes('必須の前半')).length, 1);
  assert.ok(output.includes(rule));
});

test('mandatory rules above the optional budget do not shorten optional previews within budget', () => {
  const absolute = `**🔴 ${'必須'.repeat(1500)}**`;
  const preview = '通常の案内文が長い場合には読点以降を短くする、ここは詳細への案内なので省略可能。';
  const output = makeIndex(`### 1.1 詳細\n${preview}\n${absolute}`);
  assert.ok(output.includes(absolute));
  assert.ok(output.includes(preview));
});

test('template is reproducible and contains actionable rules, not just an ONBOARDING reference', () => {
  assert.equal(read('../CLAUDE.md.template'), renderTemplate());
  for (const value of ['?authuser=kim@orgiast.jp', '/a/orgiast.jp/', 'response-language-gate',
    'rules/gas.md', '/gas-project-setup', '/deploy-verify', '200字以内', '分類Haiku→量産Sonnet→Opus5',
    '本文全文', '1社ずつ YES', '削除はuserの許可後のみ', '早朝', '空きセッションを3つ',
    '【閉じて可】', '【MM/DD/HH:MMまで】', 'pr-land.mjs', 'case-handoff.mjs flush',
    'LLM-PROVIDER-REASON', 'COST-ESTIMATE', '自動フォールバックも禁止']) {
    assert.ok(index.includes(value), value);
  }
});

test('all pre-existing numbered section entry points remain valid for gate reasons and references', () => {
  const baseline = JSON.parse(read('../docs/rule-dedupe-baseline.json'));
  const headings = new Set([...source.matchAll(/^(?:#{1,6}\s+|\*\*)(\d+(?:\.\d+)+)(?=\s)/gm)].map(m => m[1]));
  for (const number of baseline.numberedHeadings) assert.ok(headings.has(number), `missing §${number}`);
});
