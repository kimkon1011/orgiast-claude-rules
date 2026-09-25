import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadCatalog, renderMarkdown, summarize } from './ai-tool-market-map.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(toolsDir, 'ai-tool-market-map.mjs');
const report = path.resolve(toolsDir, '../docs/ai-tool-market-map.md');
const catalog = loadCatalog();
const allTools = catalog.categories.flatMap((category) => category.tools);

test('カタログのスキーマ不変条件', () => {
  assert.equal(typeof catalog.version, 'number');
  assert.ok(Array.isArray(catalog.categories) && catalog.categories.length > 0);
  assert.equal(new Set(catalog.categories.map((category) => category.id)).size, catalog.categories.length);
  for (const category of catalog.categories) {
    assert.equal(new Set(category.tools.map((tool) => tool.name)).size, category.tools.length, category.name);
    for (const tool of category.tools) {
      assert.ok(Array.isArray(tool.levels) && tool.levels.length > 0, tool.name);
      for (const level of tool.levels) assert.ok(Object.hasOwn(catalog.levels, level), `${tool.name}: ${level}`);
      assert.ok(Object.hasOwn(catalog.commercialUseValues, tool.commercialUse), tool.name);
      assert.ok(Object.hasOwn(catalog.pricingModels, tool.pricingModel), tool.name);
      assert.ok(['low', 'medium', 'high'].includes(tool.confidence), tool.name);
      assert.ok(Array.isArray(tool.sources) && tool.sources.length > 0, tool.name);
      for (const source of tool.sources) {
        assert.equal(typeof source, 'string', tool.name);
        assert.ok(source.startsWith('https://'), `${tool.name}: ${source}`);
        assert.equal(new URL(source).protocol, 'https:', tool.name);
      }
    }
  }
});

// 月額が [null,null] になる正当な理由は2つだけ:
//   (a) そもそも月額が存在しない課金形態（selfhost / metered）
//   (b) 月額が公開されていない（confidence: low）
// (b) を許すのは、公開価格が無いツールを推測値で埋めさせないため。
// 推測で数字を入れるより null + low のまま残す方が調査物として正しい。
test('価格帯の整合: 月額不明は selfhost / metered / 確度low のみ許す', () => {
  for (const tool of allTools) {
    assert.ok(Array.isArray(tool.priceBandUsdMonthly), tool.name);
    assert.equal(tool.priceBandUsdMonthly.length, 2, tool.name);
    const [min, max] = tool.priceBandUsdMonthly;
    for (const value of [min, max]) assert.ok(value === null || Number.isFinite(value), tool.name);
    if (typeof min === 'number' && typeof max === 'number') assert.ok(min <= max, tool.name);
    if (min === null && max === null) {
      assert.ok(['selfhost', 'metered'].includes(tool.pricingModel) || tool.confidence === 'low',
        `${tool.name}: priceBandUsdMonthly=[null,null] は selfhost / metered / confidence:"low" のみ許可。実値: ${tool.pricingModel} / ${tool.confidence}`);
    }
  }
});

test('orgLenses は実在カテゴリを参照する', () => {
  const ids = new Set(catalog.categories.map((category) => category.id));
  for (const lens of catalog.orgLenses) assert.ok(ids.has(lens.categoryId), lens.capability);
});

test('renderMarkdown は決定的で入力を変更しない', () => {
  const before = structuredClone(catalog);
  assert.equal(renderMarkdown(catalog), renderMarkdown(catalog));
  assert.deepEqual(catalog, before);
});

test('生成結果に全カテゴリ・ツール・ベンダーが含まれる', () => {
  const markdown = renderMarkdown(catalog);
  for (const category of catalog.categories) assert.ok(markdown.includes(category.name), category.name);
  for (const tool of allTools) {
    assert.ok(markdown.includes(tool.name), tool.name);
    assert.ok(markdown.includes(tool.vendor), tool.vendor);
  }
});

test('drift ゲート: 保存済みレポートと完全一致する', () => {
  const expected = renderMarkdown(loadCatalog());
  const regenerate = 'node tools/ai-tool-market-map.mjs --write を実行して再生成せよ';
  assert.ok(fs.existsSync(report), `${regenerate}。差分の先頭行: 1行目（実ファイルなし）`);
  const actual = fs.readFileSync(report, 'utf8');
  if (actual !== expected) {
    const expectedLines = expected.split('\n');
    const actualLines = actual.split('\n');
    let index = 0;
    while (expectedLines[index] === actualLines[index]) index += 1;
    assert.fail(`${regenerate}。差分の先頭行: ${index + 1}行目\n期待値: ${JSON.stringify(expectedLines[index] ?? '<EOF>')}\n実値: ${JSON.stringify(actualLines[index] ?? '<EOF>')}`);
  }
});

test('--check は別 cwd でも終了コード0', () => {
  assert.equal(execFileSync(process.execPath, [script, '--check'], { cwd: os.tmpdir(), encoding: 'utf8' }), '');
});

test('価格帯・通貨・従量単位・要見積を保持する', () => {
  const markdown = renderMarkdown(catalog);
  for (const value of ['$0〜$200', '無料', '$0〜', '従量/要見積', '**Premium**: 1980円/月',
    '**FLUX.2 klein 4B**: $0.014/メガピクセル', '**FLUX.1 schnell (Apache 2.0)**: $0/メガピクセル',
    '**Free**: $0/月', '**Enterprise**: 要見積', '**自前GPU**: 要見積']) {
    assert.ok(markdown.includes(value), value);
  }
});

test('出典一覧は全ツールのURLを出現順で重複排除する', () => {
  const sources = [...new Set(allTools.flatMap((tool) => tool.sources))];
  const bibliography = renderMarkdown(catalog).split('## 出典\n\n')[1].trim().split('\n');
  assert.deepEqual(bibliography, sources.map((source, index) => `${index + 1}. [${source}](<${source}>)`));
});

test('要約はカテゴリ×レベルを集計し、引数なしと --summary は同じ結果', () => {
  const sample = structuredClone(catalog);
  sample.categories = [{ name: '集計用', tools: [
    { levels: ['hobby', 'prosumer'] }, { levels: ['business'] }, { levels: ['prosumer'] },
  ] }];
  assert.equal(summarize(sample), '| カテゴリ | hobby | prosumer | business |\n| --- | --- | --- | --- |\n| 集計用 | 1 | 2 | 1 |\n');
  for (const args of [[], ['--summary']]) {
    assert.equal(execFileSync(process.execPath, [script, ...args], { cwd: os.tmpdir(), encoding: 'utf8' }), summarize(catalog));
  }
});

test('CLI は欠落・drift・末尾改行差分を検出し、--write で復旧、未知の引数は2', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tool-market-map-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tools'));
  for (const name of ['ai-tool-market-map.mjs', 'ai-tool-market-catalog.json']) {
    fs.copyFileSync(path.join(toolsDir, name), path.join(dir, 'tools', name));
  }
  const copiedScript = path.join(dir, 'tools/ai-tool-market-map.mjs');
  const copiedReport = path.join(dir, 'docs/ai-tool-market-map.md');
  const run = (...args) => execFileSync(process.execPath, [copiedScript, ...args], {
    cwd: os.tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fails = (args, code, pattern) => assert.throws(() => run(...args), (error) => {
    assert.equal(error.status, code);
    assert.match(error.stderr, pattern);
    return true;
  });
  fails(['--check'], 1, /drift.*\n最初の差分: 1行目\n期待値: .+\n実値: <ファイルなし>/);
  const output = run('--write');
  const expected = renderMarkdown(catalog);
  assert.ok(output.includes(copiedReport));
  assert.ok(output.includes(`${expected.split('\n').length - 1}行`));
  assert.equal(fs.readFileSync(copiedReport, 'utf8'), expected);
  assert.equal(run('--check'), '');
  const changed = expected.split('\n');
  changed[2] = '変更された見出し';
  fs.writeFileSync(copiedReport, changed.join('\n'));
  fails(['--check'], 1, /最初の差分: 3行目\n期待値: "# AIツール市況マップ（商用\/趣味レベル）"\n実値: "変更された見出し"/);
  fs.writeFileSync(copiedReport, expected.slice(0, -1));
  fails(['--check'], 1, /期待値: ""\n実値: <EOF>/);
  run('--write');
  assert.equal(run('--check'), '');
  fails(['--unknown'], 2, /使い方:/);
  fails(['--write', '--check'], 2, /使い方:/);
});
