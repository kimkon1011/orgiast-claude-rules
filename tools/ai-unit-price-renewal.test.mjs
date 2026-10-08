import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  parseCases, parseCasesCsv, unitPriceOf, selectWindow, splitByAi,
  summarizeUnitPrice, renewalRate, analyze, render, main,
} from './ai-unit-price-renewal.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('./ai-unit-price-renewal-catalog.json', import.meta.url), 'utf8'));
const asOf = '2026-09-26';
const row = (id, changes = {}) => ({ id, name: `案件 ${id}`, contractDate: '2026-06-01', amountYen: 120000,
  quantity: 1, unitPriceBasis: 'case', aiUsed: false, renewalTarget: true,
  renewalDueDate: asOf, renewalRenewed: true, ...changes });
const ledger = (cases) => ({ dataStatus: 'connected', source: 'テスト台帳', cases });
const fixture = () => ledger([
  row('b1', { amountYen: 100000 }),
  row('b2', { amountYen: 140000, renewalDueDate: '2026-10-01' }),
  row('a1', { aiUsed: true, amountYen: 160000, renewalRenewed: false }),
  row('a2', { aiUsed: true, amountYen: 180000, renewalDueDate: '2026-10-01' }),
  row('a3', { aiUsed: true, amountYen: 200000, renewalDueDate: '2026-10-01' }),
]);

function capture(fn) {
  const log = console.log, error = console.error;
  const stdout = [], stderr = [];
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  try { return { code: fn(), stdout: stdout.join('\n'), stderr: stderr.join('\n') }; }
  finally { console.log = log; console.error = error; }
}

test('unitPriceOf: 契約金額を数量で割る', () => {
  assert.equal(unitPriceOf(row('a')), 120000);
  assert.equal(unitPriceOf(row('b', { amountYen: 80000, quantity: 2 })), 40000);
});

test('selectWindow: 境界を含み、未来を除外し、月末を補正する', () => {
  const cases = ['2026-03-25', '2026-03-26', asOf, '2026-09-27'].map((contractDate, i) => row(String(i), { contractDate }));
  const result = selectWindow(cases, asOf, 6);
  assert.deepEqual(result.inWindow.map((r) => r.id), ['1', '2']);
  assert.equal(result.excludedOutOfWindow, 2);
  for (const [date, included, excluded] of [
    ['2026-08-31', '2026-02-28', '2026-02-27'],
    ['2024-08-31', '2024-02-29', '2024-02-28'],
    ['2026-01-31', '2025-07-31', '2025-07-30'],
  ]) {
    assert.deepEqual(selectWindow([row('yes', { contractDate: included }), row('no', { contractDate: excluded })], date, 6).inWindow.map((r) => r.id), ['yes']);
  }
  assert.throws(() => selectWindow([], '2026-02-30', 6));
  assert.throws(() => selectWindow([], asOf, -1));
});

test('splitByAi: true/false/null/欠落と導入日当日', () => {
  const cases = [row('b'), row('a', { aiUsed: true }), row('u', { aiUsed: null }), row('m', { aiUsed: undefined })];
  const groups = splitByAi(cases, 'case-flag');
  assert.deepEqual(groups.before.map((r) => r.id), ['b']);
  assert.deepEqual(groups.after.map((r) => r.id), ['a']);
  assert.deepEqual(groups.unknown.map((r) => r.id), ['u', 'm']);
  const cutoff = splitByAi([row('b', { contractDate: '2026-05-31' }), row('a')], 'cutoff-date', '2026-06-01');
  assert.deepEqual(cutoff.before.map((r) => r.id), ['b']);
  assert.deepEqual(cutoff.after.map((r) => r.id), ['a']);
  assert.throws(() => splitByAi([], 'cutoff-date', null));
  assert.throws(() => splitByAi([], 'invalid'));
});

test('summarizeUnitPrice: 基準を混ぜず、単価の合計・平均・偶数中央値・昇順を返す', () => {
  const cases = [row('p', { unitPriceBasis: 'person-day', amountYen: 80000, quantity: 2 }),
    row('c1'), row('c2', { amountYen: 240000 }), row('m', { unitPriceBasis: 'month', amountYen: 90000, quantity: 3 })];
  const snapshot = structuredClone(cases);
  assert.deepEqual(summarizeUnitPrice(cases), [
    { basis: 'case', n: 2, mean: 180000, median: 180000, min: 120000, max: 240000, totalYen: 360000 },
    { basis: 'month', n: 1, mean: 30000, median: 30000, min: 30000, max: 30000, totalYen: 30000 },
    { basis: 'person-day', n: 1, mean: 40000, median: 40000, min: 40000, max: 40000, totalYen: 40000 },
  ]);
  assert.deepEqual(cases, snapshot);
  assert.deepEqual(summarizeUnitPrice([]), []);
  const fractional = summarizeUnitPrice([row('x', { amountYen: 1, quantity: 3 })])[0];
  assert.equal(fractional.mean, 1 / 3);
});

test('renewalRate: 期日到来済みだけを分母に入れる（未到来の更新済みも除外）', () => {
  const cases = [row('yes'), row('no', { renewalRenewed: false }), row('unknown', { renewalRenewed: null }),
    row('future', { renewalDueDate: '2026-09-27' }), row('missing', { renewalDueDate: null }),
    row('not-target', { renewalTarget: false, renewalDueDate: null }), row('unknown-target', { renewalTarget: null })];
  assert.deepEqual(renewalRate(cases, asOf), { n: 3, renewed: 1, rate: 1 / 3, excludedNotDue: 1, excludedNoDueDate: 1 });
  assert.deepEqual(renewalRate(cases.slice(3), asOf), { n: 0, renewed: 0, rate: null, excludedNotDue: 1, excludedNoDueDate: 1 });
  assert.equal(renewalRate([row('no', { renewalRenewed: false })], asOf).rate, 0);
});

test('parseCases: ID付きエラーと値の正規化', () => {
  const invalid = [
    { contractDate: '2026/06/01' }, { contractDate: '2026-02-30' },
    { amountYen: 0 }, { amountYen: Infinity }, { amountYen: '100' },
    { quantity: -1 }, { quantity: NaN }, { unitPriceBasis: 'hour' },
    { aiUsed: 1 }, { renewalTarget: 'yes' }, { renewalRenewed: 0 }, { renewalDueDate: '2026-13-01' },
  ];
  for (const changes of invalid) assert.throws(() => parseCases(ledger([row('bad-id', changes)])), /案件 bad-id:/);
  assert.throws(() => parseCases(ledger([row('dup'), row('dup')])), /案件 dup:.*重複/);
  assert.throws(() => parseCases({ cases: null }), /cases/);
  assert.throws(() => parseCases(ledger([row('')])), /id/);
  assert.throws(() => parseCases({ ...ledger([]), asOf: '2026-02-29' }), /asOf/);
  const input = ledger([row('ok', { aiUsed: undefined, renewalTarget: undefined, renewalRenewed: undefined, renewalDueDate: undefined })]);
  const parsed = parseCases(input);
  for (const key of ['aiUsed', 'renewalTarget', 'renewalRenewed', 'renewalDueDate']) assert.equal(parsed.cases[0][key], null);
  assert.equal(parsed.asOf, null);
  assert.equal(input.cases[0].aiUsed, undefined);
});

const header = 'id,name,contractDate,amountYen,quantity,unitPriceBasis,aiUsed,renewalTarget,renewalDueDate,renewalRenewed';
test('parseCasesCsv: BOM/CRLF・引用符・改行・真偽値・空欄', () => {
  const csv = '\uFEFF' + header + '\r\n' + [
    'a,"案件, ""A""",2026-06-01,80000,2,person-day,1,YES,2026-09-26,no',
    'b,"複数\r\n行",2026-06-02,120000,1,case,0,No,,',
    'c,C,2026-06-03,120000,1,case,yes,TRUE,2026-09-26,1',
    'd,D,2026-06-03,120000,1,case,no,false,,0',
    'e,E,2026-06-03,120000,1,case,,true,,true',
  ].join('\r\n') + '\r\n';
  const parsed = parseCasesCsv(csv);
  assert.equal(parsed.dataStatus, 'connected');
  assert.equal(parsed.cases[0].name, '案件, "A"');
  assert.equal(parsed.cases[1].name, '複数\n行');
  assert.equal(unitPriceOf(parsed.cases[0]), 40000);
  assert.deepEqual(parsed.cases.map((r) => r.aiUsed), [true, false, true, false, null]);
  assert.deepEqual(parsed.cases.map((r) => r.renewalTarget), [true, false, true, false, true]);
  assert.deepEqual(parsed.cases.map((r) => r.renewalRenewed), [false, null, true, false, true]);
  assert.equal(parsed.cases[1].renewalDueDate, null);
});

test('parseCasesCsv: 必須列欠落・空数値・不正な真偽値と引用符を拒否', () => {
  assert.throws(() => parseCasesCsv('id,name\na,A'), /必須列/);
  assert.throws(() => parseCasesCsv(header + '\na,A,2026-06-01,,1,case,true,true,,false'), /案件 a:.*amountYen/);
  assert.throws(() => parseCasesCsv(header + '\na,A,2026-06-01,10,1,case,maybe,true,,false'), /案件 a:.*aiUsed/);
  assert.throws(() => parseCasesCsv(header + '\n"a'), /引用符/);
  assert.throws(() => parseCasesCsv(header + '\n"a"x,A,2026-06-01,10,1,case,true,true,,false'), /引用符/);
  assert.throws(() => parseCasesCsv(header + '\na,A'), /列数/);
});

test('analyze: 未接続警告・基準日の優先順位', () => {
  const empty = { dataStatus: 'not-connected', cases: [] };
  const result = analyze(empty, catalog);
  assert.equal(result.connected, false);
  assert.ok(result.warnings.some((warning) => warning.includes('未接続')));
  assert.equal(result.asOf, catalog.asOfDefault);
  assert.equal(analyze({ ...empty, asOf: null }, catalog).asOf, catalog.asOfDefault);
  assert.equal(analyze({ ...empty, asOf: '2026-09-01' }, catalog).asOf, '2026-09-01');
  assert.equal(analyze({ ...empty, asOf: '2026-09-01' }, catalog, asOf).asOf, asOf);
  assert.equal(analyze(ledger([]), catalog).connected, false);
});

test('analyze: 前2件/後3件と更新期日到来2件/未到来3件', () => {
  const result = analyze(fixture(), catalog);
  assert.equal(result.connected, true);
  assert.equal(result.source, 'テスト台帳');
  assert.equal(result.totalCases, 5);
  assert.equal(result.inWindow, 5);
  assert.deepEqual(result.unitPrice.comparison, [{ basis: 'case', beforeN: 2, afterN: 3,
    beforeMean: 120000, afterMean: 180000, diffYen: 60000, ratioPct: 50, reliable: false }]);
  assert.deepEqual(result.renewal.comparison, { beforeN: 1, afterN: 1, beforeRate: 1, afterRate: 0, diffPctPoint: -100, reliable: false });
  assert.equal(result.renewal.before.excludedNotDue, 1);
  assert.equal(result.renewal.after.excludedNotDue, 2);
});

test('analyze: unknown/窓外を除外し、片群なしの差分は null、n=5から信頼判定', () => {
  const result = analyze(ledger([row('a'), row('u', { aiUsed: null }), row('out', { contractDate: '2026-03-25' })]), catalog);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.excludedOutOfWindow, 1);
  assert.equal(result.unitPrice.comparison[0].afterMean, null);
  assert.equal(result.unitPrice.comparison[0].diffYen, null);
  assert.equal(result.unitPrice.comparison[0].ratioPct, null);
  assert.equal(result.renewal.comparison.diffPctPoint, null);
  const enough = analyze(ledger(Array.from({ length: 10 }, (_, i) => row(String(i), { aiUsed: i >= 5 }))), catalog);
  assert.equal(enough.unitPrice.comparison[0].reliable, true);
  assert.equal(enough.renewal.comparison.reliable, true);
});

test('render: 未接続・必要な入力・null表示・参考値・決定性', () => {
  const disconnected = render(catalog, analyze({ dataStatus: 'not-connected', cases: [] }, catalog));
  assert.match(disconnected, /未接続/);
  assert.match(disconnected, /## 必要な入力/);
  assert.match(disconnected, /case\\\|person-day\\\|month/);
  assert.doesNotMatch(disconnected, /### 契約更新率/);
  const input = analyze(ledger([row('only')]), catalog);
  const output = render(catalog, input);
  assert.match(output, /—/);
  assert.match(output, /参考値（n<5）/);
  assert.ok(output.endsWith('\n'));
  assert.equal(output, render(catalog, input));
  const comparison = render(catalog, analyze(fixture(), catalog));
  assert.match(comparison, /\+60,000 円/);
  assert.match(comparison, /\+50\.0%/);
  assert.match(comparison, /-100\.0pt/);
  assert.doesNotMatch(comparison, /> ⚠️/);
});

test('main: 概要・雛形・未知引数と引数過多', () => {
  const summary = capture(() => main([]));
  assert.equal(summary.code, 0);
  assert.match(summary.stdout, /接続状態:.*総件数:.*分析窓の対象件数:.*unknown 件数:/);
  const template = capture(() => main(['--template']));
  assert.equal(template.code, 0);
  assert.equal(parseCases(JSON.parse(template.stdout)).cases.length, 1);
  for (const args of [['--unknown'], ['extra'], ['--write', '--check'], ['--analyze'], ['--asof', '2026-02-30'], ['--template', 'extra'], ['--asof', asOf, '--asof', asOf]]) {
    const result = capture(() => main(args));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /使い方:/);
  }
});

test('main: 一時コピーで --write → --check、CRLF、drift、固定日、JSON/CSV分析', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-unit-price-renewal-'));
  try {
    const toolsDir = path.join(temp, 'tools');
    fs.mkdirSync(toolsDir);
    for (const name of ['ai-unit-price-renewal.mjs', 'ai-unit-price-renewal-catalog.json', 'ai-unit-price-renewal-cases.json', 'is-entry.mjs']) {
      fs.copyFileSync(new URL(`./${name}`, import.meta.url), path.join(toolsDir, name));
    }
    const isolated = await import(pathToFileURL(path.join(toolsDir, 'ai-unit-price-renewal.mjs')).href);
    const call = (args) => capture(() => isolated.main(args));
    const ledgerPath = path.join(toolsDir, 'ai-unit-price-renewal-cases.json');
    fs.writeFileSync(ledgerPath, JSON.stringify({ ...fixture(), asOf: '2026-09-01' }));
    assert.equal(call(['--check']).code, 1);
    assert.equal(call(['--write']).code, 0);
    assert.equal(call(['--check']).code, 0);
    const docPath = path.join(temp, 'docs', 'ai-unit-price-renewal.md');
    const doc = fs.readFileSync(docPath, 'utf8');
    assert.match(doc, new RegExp(`基準日: ${catalog.asOfDefault}`));
    fs.writeFileSync(docPath, doc.replace(/\n/g, '\r\n'));
    assert.equal(call(['--check']).code, 0);
    fs.writeFileSync(docPath, doc + 'drift\n');
    assert.equal(call(['--check']).code, 1);
    assert.equal(call(['--asof', '2026-09-01', '--write']).code, 0);
    assert.equal(call(['--check', '--asof', '2026-09-01']).code, 0);
    assert.equal(call(['--check']).code, 1);
    const json = call(['--analyze', ledgerPath]);
    assert.equal(json.code, 0);
    assert.match(json.stdout, /基準日: 2026-09-01/);
    assert.match(call(['--asof', asOf, '--analyze', ledgerPath]).stdout, /基準日: 2026-09-26/);
    const csvPath = path.join(temp, 'sample.csv');
    fs.writeFileSync(csvPath, header + '\na,A,2026-06-01,120000,1,case,true,true,,false\n');
    assert.equal(call(['--analyze', csvPath]).code, 0);
    fs.writeFileSync(csvPath, 'id\na');
    assert.equal(call(['--analyze', csvPath]).code, 2);
    assert.equal(call(['--analyze', path.join(temp, 'missing.json')]).code, 2);
    fs.writeFileSync(ledgerPath, '{invalid');
    assert.equal(call(['--analyze', ledgerPath]).code, 2);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
