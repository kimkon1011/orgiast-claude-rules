import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  loadCatalog, renderDoc, checkDocInSync, checkMemoryIndexByteCap,
  checkClaudeMdNoCurrentDate, checkMemoryFrontmatter, checkMemoryDomainIndexPresent,
  primaryMemoryDirectory,
} from './prompt-memory-guideline.mjs';

const memoryPrimary = ({ home }) => primaryMemoryDirectory(home);

const scriptPath = fileURLToPath(new URL('./prompt-memory-guideline.mjs', import.meta.url));
const sourceRepo = path.dirname(path.dirname(scriptPath));
const catalog = loadCatalog(sourceRepo);
const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture({ withDoc = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-memory-guideline-'));
  temporaryRoots.push(root);
  const context = { home: path.join(root, 'home'), repoRoot: path.join(root, 'repo'), now: new Date('2026-09-23T00:30:00Z') };
  fs.mkdirSync(context.home);
  write(path.join(context.repoRoot, 'tools', 'prompt-memory-guideline.json'), JSON.stringify(catalog));
  if (withDoc) write(document(context), renderDoc(catalog));
  return context;
}

const document = ({ repoRoot }) => path.join(repoRoot, 'docs', 'prompt-memory-optimization.md');
// 検査対象は「索引 MEMORY.md を持つ記憶ディレクトリ」だけなので、fixture でも必ず索引を置く。
function memory({ home }, project = 'project-a') {
  const directory = path.join(home, '.claude', 'projects', project, 'memory');
  fs.mkdirSync(directory, { recursive: true });
  const index = path.join(directory, 'MEMORY.md');
  if (!fs.existsSync(index)) fs.writeFileSync(index, '# 索引\n');
  return directory;
}
const params = (type) => catalog.rules.find((rule) => rule.check?.type === type).check;

function cli(context, ...args) {
  // --home is always explicit for checks; list/write cannot inspect a user's home.
  return spawnSync(process.execPath, [scriptPath, '--repo', context.repoRoot,
    ...(args.includes('--check') ? ['--home', context.home] : []), ...args], { encoding: 'utf8' });
}

function report(context) {
  const result = cli(context, '--check', '--json');
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  assert.ok([0, 1].includes(result.status), result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.status, parsed.ok ? 0 : 1);
  return parsed;
}

function checkResult(reportValue, type) {
  const rule = catalog.rules.find((item) => item.check?.type === type);
  const result = reportValue.results.find((item) => item.id === rule.id);
  assert.ok(result, `${rule.id}: ${type}`);
  return result;
}

test('catalog has thirteen rules with unique IDs', () => {
  assert.equal(catalog.rules.length, 13);
  assert.equal(new Set(catalog.rules.map((rule) => rule.id)).size, 13);
});

test('renderDoc includes every rule and has deterministic LF formatting', () => {
  const doc = renderDoc(catalog);
  assert.equal(doc, renderDoc(catalog));
  for (const rule of catalog.rules) assert.ok(doc.includes(`### ${rule.id} ${rule.title}\n`));
  assert.equal(doc.includes('\r'), false);
  assert.match(doc, /[^\n]\n$/);
  assert.equal(doc.split('\n').some((line) => /[\t ]$/.test(line)), false);
  const headings = ['## 原則', '## 規則', '## 既存ツールとの対応', '## 実測から得た教訓'];
  headings.forEach((heading, index) => {
    assert.ok(doc.includes(heading));
    if (index) assert.ok(doc.indexOf(headings[index - 1]) < doc.indexOf(heading));
  });
});

test('renderDoc follows the exact template including optional evidence', () => {
  const small = { purpose: '目的', principles: ['原則'], rules: [
    { id: 'PM-01', title: '題', rule: '規範', why: '理由', howToApply: ['一', '二'], check: null },
    { id: 'PM-02', title: '題二', rule: '規範二', why: '理由二', howToApply: ['三'], check: { type: 'memory-frontmatter' }, evidence: ['A', 'B'] },
  ], tooling: [{ tool: 'tools/a.mjs', role: '役割' }], lessons: ['教訓'] };
  assert.equal(renderDoc(small), [
    '# プロンプトとメモリ最適化ガイドライン', '',
    '<!-- tools/prompt-memory-guideline.json から tools/prompt-memory-guideline.mjs --write で生成。手で編集しない。 -->', '',
    '目的', '', '## 原則', '- 原則', '', '## 規則',
    '### PM-01 題', '- 規則: 規範', '- 理由: 理由', '- 適用: 一 / 二', '- 検査: 手動（規範）', '',
    '### PM-02 題二', '- 規則: 規範二', '- 理由: 理由二', '- 適用: 三', '- 検査: 自動（memory-frontmatter）', '- 根拠: A / B', '',
    '## 既存ツールとの対応', '- `tools/a.mjs` — 役割', '', '## 実測から得た教訓', '- 教訓', '',
  ].join('\n'));
});

test('--write creates a missing docs directory, then --check succeeds', () => {
  const context = fixture({ withDoc: false });
  const result = cli(context, '--write');
  assert.equal(result.status, 0, result.stderr);
  const doc = fs.readFileSync(document(context), 'utf8');
  assert.equal(doc, renderDoc(catalog));
  assert.equal(result.stdout, `wrote docs/prompt-memory-optimization.md (${Buffer.byteLength(doc)} bytes)\n`);
  const check = cli(context, '--check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /^PASS doc-in-sync:/);
  assert.ok(check.stdout.trim().split('\n').every((line) => /^(PASS|FAIL|SKIP) [^:]+: /.test(line)));
});

test('missing and modified documents fail drift checks; --write repairs drift', () => {
  const context = fixture({ withDoc: false });
  assert.equal(checkDocInSync(context).status, 'fail');
  assert.equal(report(context).docInSync, false);
  write(document(context), renderDoc(catalog) + '追加行\n');
  const result = cli(context, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL doc-in-sync:/);
  assert.equal(cli(context, '--write').status, 0);
  assert.equal(checkDocInSync(context).status, 'pass');
});

test('byte-cap check reports oversize paths and actual byte counts via JSON', () => {
  const context = fixture();
  const file = path.join(memory(context), 'MEMORY.md');
  write(file, 'あ'.repeat(10000));
  const failed = checkResult(report(context), 'memory-index-byte-cap');
  assert.equal(failed.status, 'fail');
  assert.ok(failed.detail.includes(file));
  assert.ok(failed.detail.includes('30000'));
  assert.ok(failed.detail.includes(String(params('memory-index-byte-cap').limitBytes)));
  write(file, 'a'.repeat(1000));
  const passed = checkResult(report(context), 'memory-index-byte-cap');
  assert.equal(passed.status, 'pass');
  assert.ok(passed.detail.includes('1000'));
});

test('byte cap accepts the exact limit and checks only the primary memory directory', () => {
  const context = fixture();
  const check = params('memory-index-byte-cap');
  const first = path.join(memory(context, 'project-a'), 'MEMORY.md');
  write(first, Buffer.alloc(check.limitBytes + 1));
  // 同数ならパス順で project-a が正本。上限ちょうどは pass。
  write(path.join(memory(context, 'project-b'), 'MEMORY.md'), Buffer.alloc(check.limitBytes));
  assert.equal(memoryPrimary(context), path.dirname(first));
  assert.equal(checkMemoryIndexByteCap(context, check).status, 'fail');
  assert.ok(checkMemoryIndexByteCap(context, check).detail.includes(first));
  // memory を多く抱えるディレクトリが正本になる（project-b は MEMORY.md + b.md の2件）。
  write(path.join(memory(context, 'project-b'), 'b.md'), '---\nname: b\ndescription: b\nmetadata:\n  type: feedback\n---\n');
  write(path.join(memory(context, 'project-b'), 'MEMORY.md'), Buffer.alloc(check.limitBytes));
  const passed = checkMemoryIndexByteCap(context, check);
  assert.equal(passed.status, 'pass');
  assert.ok(passed.detail.includes('保守対象外の記憶ディレクトリ 1 件'));
});

test('missing memory directories skip all memory checks without violations', () => {
  const context = fixture();
  const result = report(context);
  for (const type of ['memory-index-byte-cap', 'memory-frontmatter', 'memory-domain-index-present']) {
    assert.equal(checkResult(result, type).status, 'skip');
  }
  assert.equal(checkMemoryIndexByteCap(context, params('memory-index-byte-cap')).detail, 'MEMORY.md が見つからない');
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('frontmatter checks valid files, reports missing metadata, and ignores plain markdown and indexes', () => {
  const context = fixture();
  const dir = memory(context);
  write(path.join(dir, 'valid.md'), '---\nname: valid\ndescription: valid description\nmetadata:\n  type: feedback\n---\n本文\n');
  write(path.join(dir, 'plain.md'), '# 古い形式\n');
  write(path.join(dir, 'MEMORY.md'), '---\nname:\n---\n');
  write(path.join(dir, 'index', 'a.md'), '---\nname:\n---\n');
  const check = params('memory-frontmatter');
  const passed = checkMemoryFrontmatter(context, check);
  assert.equal(passed.status, 'pass');
  assert.match(passed.detail, /1 件/);
  write(path.join(dir, 'missing-metadata.md'), '---\nname: bad\ndescription: bad description\n---\n');
  const failed = checkResult(report(context), 'memory-frontmatter');
  assert.equal(failed.status, 'fail');
  assert.ok(failed.detail.includes('missing-metadata.md'));
  // 違反として挙がるのは missing-metadata.md だけ。部分文字列一致だと 'metadata.md' が
  // 'a.md' を含むため誤判定するので、違反ファイルの絶対パスで照合する。
  assert.deepEqual(failed.detail.split(' / ').map((entry) => entry.slice(0, entry.indexOf(': '))),
    [path.join(dir, 'missing-metadata.md')]);
});

test('frontmatter rejects empty fields, missing types, and types outside metadata', () => {
  const context = fixture();
  const bodies = {
    'empty-name.md': 'name: ""\ndescription: desc\nmetadata:\n  type: user',
    'empty-description.md': "name: name\ndescription: ''\nmetadata:\n  type: user",
    'missing-name.md': 'description: desc\nmetadata:\n  type: project',
    'missing-description.md': 'name: name\nmetadata:\n  type: project',
    'bad-type.md': 'name: name\ndescription: desc\nmetadata:\n  type: unknown',
    'missing-type.md': 'name: name\ndescription: desc\nmetadata:\n  origin: value',
    'wrong-block.md': 'name: name\ndescription: desc\nmetadata:\n  origin: value\nother:\n  type: user',
    'nested-type.md': 'name: name\ndescription: desc\nmetadata:\n  other:\n    type: user',
  };
  for (const [name, body] of Object.entries(bodies)) write(path.join(memory(context), name), `---\n${body}\n---\n`);
  const result = checkMemoryFrontmatter(context, params('memory-frontmatter'));
  assert.equal(result.status, 'fail');
  for (const name of Object.keys(bodies)) assert.ok(result.detail.includes(name), name);
});

test('frontmatter supports CRLF, quoted types and nonempty multiline descriptions', () => {
  const context = fixture();
  write(path.join(memory(context), 'valid.md'), '---\r\nname: "valid"\r\ndescription: >\r\n  description text\r\nmetadata:\r\n  type: "reference" # comment\r\n---\r\n');
  assert.equal(checkMemoryFrontmatter(context, params('memory-frontmatter')).status, 'pass');
});

test('frontmatter skips an empty memory directory or one containing only plain markdown', () => {
  const context = fixture();
  fs.mkdirSync(memory(context), { recursive: true });
  assert.equal(checkMemoryFrontmatter(context, params('memory-frontmatter')).status, 'skip');
  write(path.join(memory(context), 'plain.md'), '# No frontmatter\n');
  assert.equal(checkMemoryFrontmatter(context, params('memory-frontmatter')).status, 'skip');
});

test('domain index must contain a direct markdown file in every memory directory', () => {
  const context = fixture();
  fs.mkdirSync(memory(context), { recursive: true });
  assert.equal(checkResult(report(context), 'memory-domain-index-present').status, 'fail');
  fs.mkdirSync(path.join(memory(context), 'index'));
  assert.equal(checkMemoryDomainIndexPresent(context).status, 'fail');
  write(path.join(memory(context), 'index', 'nested', 'a.md'), '# Nested\n');
  assert.equal(checkMemoryDomainIndexPresent(context).status, 'fail');
  write(path.join(memory(context), 'index', 'a.md'), '# Index\n');
  assert.equal(checkResult(report(context), 'memory-domain-index-present').status, 'pass');
  // 索引を持たない別ディレクトリ（保守対象外）は違反にしない。
  memory(context, 'project-b');
  assert.equal(checkMemoryDomainIndexPresent(context).status, 'pass');
  assert.ok(checkMemoryDomainIndexPresent(context).detail.includes('保守対象外'));
});

test('current-date check uses the injected UTC date rather than local date', () => {
  const context = fixture();
  context.now = new Date('2026-09-23T00:30:00+09:00');
  assert.equal(checkClaudeMdNoCurrentDate(context).status, 'skip');
  const file = path.join(context.home, '.claude', 'CLAUDE.md');
  write(file, '今日: 2026-09-22\n');
  assert.equal(checkClaudeMdNoCurrentDate(context).status, 'fail');
  write(file, '別の日: 2026-09-23\n');
  assert.equal(checkClaudeMdNoCurrentDate(context).status, 'pass');
});

test('--json emits only a report with failures mirrored in violations', () => {
  const context = fixture({ withDoc: false });
  const result = report(context);
  assert.ok(Array.isArray(result.results));
  assert.ok(Array.isArray(result.violations));
  assert.equal(result.ok, false);
  assert.equal(result.docInSync, false);
  assert.equal(new Date(result.generatedAt).toISOString(), result.generatedAt);
  assert.deepEqual(result.violations, result.results.filter((item) => item.status === 'fail').map((item) => `${item.id}: ${item.detail}`));
  assert.ok(result.results.every((item) => ['pass', 'fail', 'skip'].includes(item.status)));
});

test('--list prints catalog order, categories and titles', () => {
  const result = cli(fixture(), '--list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, catalog.rules.map((rule) => `${rule.id} ${rule.category} ${rule.title}\n`).join(''));
});

test('no mode, unknown flags, conflicting modes and missing option values exit 2', () => {
  const context = fixture();
  for (const args of [[], ['--unknown'], ['--check', '--unknown'], ['--check', '--write'], ['--list', '--list'],
    ['--write', '--json'], ['--list', '--json'], ['--json'], ['--check', '--home'], ['--write', '--repo'],
    ['--check', '--home', '--json'], ['--write', '--home', context.home]]) {
    const result = cli(context, ...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /usage:/);
    assert.equal(result.stdout, '');
  }
  // Exercise a genuinely empty argv as well as the helper's --repo-only form.
  const empty = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /usage:/);
});
