import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeRouteEconomics, computeReport, pickRecommendation, renderMarkdown, runPlan, validateCatalog } from './receipt-automation-plan.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('./receipt-automation-catalog.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(catalog);
const quiet = () => ({ stdout: { write() {} }, stderr: { write() {} } });
const headings = ['# レシート自動入力とカレンダー連携ツールの導入 ルート比較（P-0135）', '## 結論', '## ルート比較', '## 感度分析', '## カレンダー照合の実装スケッチ', '## 前提（仮定であり実測ではない）', '## 見積必須・未確認', '## 出典'];

test('正常カタログ', () => assert.deepEqual(validateCatalog(catalog), []));
test('見積必須ルートに金額を入れると拒否', () => {
  for (const key of ['fixedYen', 'licenseYenPerMonth']) {
    const c = clone(); c.routes[1][key] = 0;
    assert.ok(validateCatalog(c).some((e) => e.includes('quote-required')));
  }
});
test('secondary の出典欠落を拒否', () => {
  const c = clone(); delete c.routes[0].priceSource;
  assert.ok(validateCatalog(c).some((e) => e.includes('priceSource')));
});
test('構造・重複・不正数値・前提欠落を拒否', () => {
  for (const mutate of [
    (c) => { c.version = 2; }, (c) => { c.priceAsOf = ''; }, (c) => { c.proposalId = ''; },
    (c) => { c.routes = []; }, (c) => { c.routes[1].id = c.routes[0].id; },
    (c) => { delete c.routes[0].id; }, (c) => { delete c.routes[0].label; },
    (c) => { c.routes[0].priceVerify = 'unknown'; }, (c) => { delete c.assumptions.hourlyYen; },
    ...[NaN, Infinity, -1, '3', undefined].map((v) => (c) => { c.routes[0].devDays = v; }),
    (c) => { c.assumptions.hourlyYen = -1; },
  ]) { const c = clone(); mutate(c); assert.ok(validateCatalog(c).length > 0); }
  assert.ok(validateCatalog(null).length > 0);
});
test('未取得ライセンスは月額・純効果・回収にnullを伝播する', () => {
  const e = computeRouteEconomics({ ...catalog.routes[0], licenseYenPerMonth: null }, catalog.assumptions);
  for (const key of ['monthlyCostYen', 'netYenPerMonth', 'paybackMonths', 'annualNetYen']) assert.equal(e[key], null);
});
test('nullの無料枠・単価・日数・分数を0と解釈しない', () => {
  for (const [key, output] of [['includedCasesPerMonth', 'monthlyCostYen'], ['overageYenPerCase', 'monthlyCostYen'], ['llmYenPerCase', 'monthlyCostYen'], ['fixedYen', 'initialCostYen'], ['devDays', 'initialCostYen'], ['residualMinutesPerCase', 'netYenPerMonth']]) {
    assert.equal(computeRouteEconomics({ ...catalog.routes[0], [key]: null }, catalog.assumptions)[output], null);
  }
  // 自前ルートは無料枠0件・超過0円/件＝従量課金が無い。よって月額はLLM従量のみで算出できる。
  assert.equal(computeRouteEconomics(catalog.routes[4], catalog.assumptions).monthlyCostYen, catalog.assumptions.casesPerMonth * catalog.assumptions.llmYenPerCase);
  assert.equal(computeRouteEconomics(catalog.routes[0], { ...catalog.assumptions, hourlyYen: null }).netYenPerMonth, null);
});
test('無料枠の前後と境界・基本計算', () => {
  for (const [casesPerMonth, overageCases] of [[50, 0], [60, 0], [200, 140]]) {
    const e = computeRouteEconomics(catalog.routes[0], catalog.assumptions, { casesPerMonth });
    assert.equal(e.overageCases, overageCases);
    assert.equal(e.overageYen, overageCases * 20);
    assert.equal(e.monthlyCostYen, 4480 + overageCases * 20);
    assert.equal(e.baselineHoursPerMonth, casesPerMonth * 5.5 / 60);
    assert.equal(e.residualHoursPerMonth, casesPerMonth * 1.2 / 60);
    assert.equal(e.netYenPerMonth, e.savedHoursPerMonth * 2500 - e.monthlyCostYen);
    assert.equal(e.annualNetYen, e.netYenPerMonth * 12);
    assert.equal(e.paybackMonths, 0);
  }
});
test('負の削減・純効果を保存し回収不可を返す', () => {
  const e = computeRouteEconomics({ ...catalog.routes[0], residualMinutesPerCase: 10 }, catalog.assumptions);
  assert.ok(e.savedHoursPerMonth < 0); assert.ok(e.netYenPerMonth < 0); assert.equal(e.paybackMonths, null);
});
test('自前LLMの上書きと初期費用・回収計算', () => {
  const r = { ...catalog.routes[4], includedCasesPerMonth: 1000 };
  const e = computeRouteEconomics(r, catalog.assumptions, { llmYenPerCase: 10, devDayYen: 100 });
  assert.equal(e.monthlyCostYen, 2000); assert.equal(e.initialCostYen, 500);
  assert.equal(e.paybackMonths, 500 / e.netYenPerMonth);
  assert.equal(computeRouteEconomics({ ...r, llmYenPerCase: null }, catalog.assumptions, { llmYenPerCase: 10 }).monthlyCostYen, null);
});
test('推奨は見積必須と要件未達を除き純効果最大', () => {
  const report = computeReport(catalog);
  assert.equal(pickRecommendation([...report, { id: 'excluded', priceVerify: 'quote-required', netYenPerMonth: 1e9 }]).id, 'diy-gas');
  const cap = { receiptToPdf: true, calendarReconcile: true };
  assert.equal(pickRecommendation([{ id: 'a', priceVerify: 'primary', netYenPerMonth: 1, ...cap }, { id: 'b', priceVerify: 'assumed', netYenPerMonth: 2, ...cap }]).id, 'b');
  // 会計SaaS内蔵OCRはカレンダー照合もPDF作成も持たないため、純効果が最大でも推奨にしない。
  assert.equal(pickRecommendation([{ id: 'saas', priceVerify: 'primary', netYenPerMonth: 1e9, receiptToPdf: false, calendarReconcile: false }]), null);
});
test('候補0件ならnullと未取得理由・名前付きID', () => {
  assert.equal(pickRecommendation([]), null);
  const c = clone(); c.routes = c.routes.filter((r) => r.priceVerify === 'quote-required');
  const report = computeReport(c); assert.equal(pickRecommendation(report), null);
  const md = renderMarkdown(c, report, c.assumptions);
  assert.ok(md.includes('導入判断に必要な価格が未取得（見積必須）:'));
  for (const r of c.routes) assert.ok(md.includes(`${r.label}（${r.id}）`));
});
test('仮定推奨にキー一覧、即時回収、未確認事項を表示', () => {
  const c = clone(); c.routes[0].priceVerify = 'assumed';
  const md = renderMarkdown(c, computeReport(c), c.assumptions);
  assert.ok(md.includes('この推奨は仮定値に依存する（仮定: casesPerMonth'));
  assert.ok(md.includes('diy-gas.fixedYen'));
  assert.ok(md.includes('manualTimeMeasured'));
  const zero = clone(); zero.routes.find((r) => r.id === 'diy-gas').devDays = 0;
  assert.ok(renderMarkdown(zero, computeReport(zero), zero.assumptions).includes('初期費用0円のため即時'));
});
test('--write生成・見出し順・LF末尾と--check一致/CRLF/改変/欠落', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const docPath = path.join(dir, 'docs', 'plan.md');
  const options = { docPath, ...quiet() };
  assert.equal(runPlan({ ...options, args: ['--check'] }), 1);
  assert.equal(runPlan({ ...options, args: ['--write'] }), 0);
  const md = fs.readFileSync(docPath, 'utf8');
  let previous = -1;
  for (const heading of headings) { const position = md.indexOf(heading); assert.ok(position > previous); previous = position; }
  assert.match(md, /[^\n]\n$/u); assert.ok(!md.includes('\r'));
  assert.equal(runPlan({ ...options, args: ['--check'] }), 0);
  fs.writeFileSync(docPath, md.replace(/\n/gu, '\r\n'));
  assert.equal(runPlan({ ...options, args: ['--check'] }), 0);
  fs.writeFileSync(docPath, `${md}改変\n`);
  assert.equal(runPlan({ ...options, args: ['--check'] }), 1);
});
test('未知引数・競合モード・不正数値は1行エラー', () => {
  for (const args of [['--unknown'], ['--json', '--check'], ['--write', '--write'], ['--cases'], ['--cases', 'NaN'], ['--cases', '-1'], ['--cases', 'Infinity'], ['--cases', '']]) {
    let error = '';
    assert.equal(runPlan({ args, stdout: quiet().stdout, stderr: { write(s) { error += s; } } }), 1);
    assert.equal(error.trimEnd().split('\n').length, 1);
  }
});
test('6種類のCLI上書きをJSONと感度分析に反映', () => {
  let output = '';
  const args = ['--json', '--cases', '100', '--manual-minutes', '6', '--reconcile-minutes', '2', '--hourly-yen', '3000', '--llm-yen-per-case', '8', '--dev-day-yen', '10000'];
  assert.equal(runPlan({ args, stdout: { write(s) { output += s; } }, stderr: quiet().stderr }), 0);
  const result = JSON.parse(output);
  assert.deepEqual(result.assumptions, { casesPerMonth: 100, manualMinutesPerCase: 6, reconcileMinutesPerCase: 2, hourlyYen: 3000, llmYenPerCase: 8, devDayYen: 10000 });
  assert.equal(result.routes[4].llmYenPerCase, 8);
  const md = renderMarkdown(catalog, result.routes, result.assumptions);
  const expected = computeRouteEconomics(catalog.routes[0], result.assumptions, { casesPerMonth: 50 }).netYenPerMonth.toLocaleString('ja-JP', { maximumFractionDigits: 0 });
  assert.ok(md.includes(`| ${expected} |`));
});
test('実リポジトリの生成docにdriftがない', () => assert.equal(runPlan({ check: true, ...quiet() }), 0));
