import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeRouteEconomics, computeReport, meetsProposalRequirements, pickRecommendation, renderMarkdown, parseCli, runPlan, validateCatalog } from './physical-ai-prototyping-plan.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('./physical-ai-prototyping-catalog.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(catalog);
const quiet = () => ({ stdout: { write() {} }, stderr: { write() {} } });
const headings = ['# フィジカルAIを活用したプロトタイプ高速化 ルート比較（P-0137）', '## 結論', '## ルート比較', '## 感度分析', '## 模倣学習の実装スケッチ', '## 前提（仮定であり実測ではない）', '## 見積必須・未確認', '## 出典'];

test('正常カタログ', () => assert.deepEqual(validateCatalog(catalog), []));
test('見積必須ルートにgadgetYenまたはbuildDaysを入れると拒否', () => {
  for (const key of ['gadgetYen', 'buildDays']) {
    const c = clone(); Object.assign(c.routes[0], { priceVerify: 'quote-required', gadgetYen: null, buildDays: null });
    assert.deepEqual(validateCatalog(c), []);
    c.routes[0][key] = 0;
    assert.ok(validateCatalog(c).some((e) => e.includes('quote-required')));
  }
});
test('primary / secondary の出典欠落・非HTTPSを拒否', () => {
  for (const priceVerify of ['primary', 'secondary']) {
    for (const priceSource of [undefined, '', 'http://example.com', 3]) {
      const c = clone(); Object.assign(c.routes[0], { priceVerify, priceSource });
      assert.ok(validateCatalog(c).some((e) => e.includes('priceSource')));
    }
  }
});
test('構造・重複・不正数値・前提欠落を拒否', () => {
  for (const mutate of [
    (c) => { c.version = 2; }, (c) => { c.priceAsOf = ''; }, (c) => { c.proposalId = ''; },
    (c) => { c.routes = []; }, (c) => { c.routes = {}; }, (c) => { c.routes[0] = null; },
    (c) => { c.routes[1].id = c.routes[0].id; }, (c) => { delete c.routes[0].id; }, (c) => { delete c.routes[0].label; },
    (c) => { c.routes[0].priceVerify = 'unknown'; }, (c) => { delete c.assumptions; },
    ...Object.keys(catalog.assumptions).map((key) => (c) => { delete c.assumptions[key]; }),
    ...[NaN, Infinity, -1, '3', undefined].map((v) => (c) => { c.routes[0].gadgetYen = v; }),
    (c) => { c.assumptions.hourlyYen = -1; }, (c) => { c.assumptions.demandCaptureRate = 1.5; },
    (c) => { c.routes[0].leadDays = 0; },
  ]) { const c = clone(); mutate(c); assert.ok(validateCatalog(c).length > 0); }
  assert.ok(validateCatalog(null).length > 0);
  const c = clone(); c.assumptions.demandCaptureRate = 1.5; c.routes[0].leadDays = 0;
  assert.ok(validateCatalog(c).includes('assumptions.demandCaptureRate は0以上1以下が必要です'));
  assert.ok(validateCatalog(c).includes(`${c.routes[0].id}.leadDays は null または1以上が必要です`));
  for (const demandCaptureRate of [null, 0, 1]) {
    c.assumptions.demandCaptureRate = demandCaptureRate;
    for (const leadDays of [null, 1]) { c.routes[0].leadDays = leadDays; assert.deepEqual(validateCatalog(c), []); }
  }
});
test('需要転換率0では売上効果が0で工数削減だけが残る', () => {
  for (const route of catalog.routes) {
    const e = computeRouteEconomics(route, catalog.assumptions, { demandCaptureRate: 0 });
    assert.equal(e.extraMarginYenPerMonth, 0);
    assert.equal(e.grossBenefitYenPerMonth, e.laborSavedYenPerMonth);
    // 指定式では純効果は0固定ではなく、工数削減額から月額費用を引く。
    assert.equal(e.netYenPerMonth, e.laborSavedYenPerMonth - e.monthlyCostYen);
  }
});
test('需要転換率nullでは売上効果・純効果・回収期間を算出しない', () => {
  const e = computeRouteEconomics(catalog.routes[0], catalog.assumptions, { demandCaptureRate: null });
  for (const key of ['extraMarginYenPerMonth', 'grossBenefitYenPerMonth', 'netYenPerMonth', 'paybackMonths', 'annualNetYen']) assert.equal(e[key], null);
  assert.ok(e.laborSavedYenPerMonth > 0);
});
test('nullの金額・日数・分数・前提を0と解釈しない', () => {
  for (const [key, outputs] of [
    ['gadgetYen', ['monthlyGadgetYen', 'monthlyCostYen', 'initialCostYen', 'netYenPerMonth', 'paybackMonths', 'annualNetYen']],
    ['buildDays', ['initialCostYen', 'paybackMonths']],
    ['consumablesYenPerMonth', ['monthlyCostYen', 'netYenPerMonth', 'paybackMonths']],
    ['cloudYenPerMonth', ['monthlyCostYen', 'netYenPerMonth', 'paybackMonths']],
    ['residualMinutesPerPrototype', ['savedMinutesPerPrototype', 'laborSavedYenPerMonth', 'grossBenefitYenPerMonth', 'netYenPerMonth', 'paybackMonths']],
    ['leadDays', ['speedupRatio', 'extraPrototypesPerMonth', 'extraMarginYenPerMonth', 'netYenPerMonth']],
  ]) {
    const e = computeRouteEconomics({ ...catalog.routes[0], [key]: null }, catalog.assumptions);
    for (const output of outputs) assert.equal(e[output], null, `${key} → ${output}`);
  }
  for (const key of Object.keys(catalog.assumptions)) {
    assert.equal(computeRouteEconomics(catalog.routes[0], { ...catalog.assumptions, [key]: null }).paybackMonths, null, key);
  }
});
test('件数1/2/4/8の境界と基本計算', () => {
  for (const route of catalog.routes) {
    for (const prototypesPerMonth of [1, 2, 4, 8]) {
      const e = computeRouteEconomics(route, catalog.assumptions, { prototypesPerMonth });
      assert.equal(e.monthlyGadgetYen, route.gadgetYen / 24);
      assert.equal(e.monthlyCostYen, route.gadgetYen / 24 + route.consumablesYenPerMonth + route.cloudYenPerMonth);
      assert.equal(e.savedMinutesPerPrototype, 240 - route.residualMinutesPerPrototype);
      assert.equal(e.laborSavedYenPerMonth, (240 - route.residualMinutesPerPrototype) * prototypesPerMonth / 60 * 2500);
      assert.equal(e.speedupRatio, 14 / route.leadDays);
      assert.equal(e.extraPrototypesPerMonth, prototypesPerMonth * e.speedupRatio - prototypesPerMonth);
      assert.equal(e.extraMarginYenPerMonth, e.extraPrototypesPerMonth * 80000 * 0.2);
      assert.equal(e.grossBenefitYenPerMonth, e.laborSavedYenPerMonth + e.extraMarginYenPerMonth);
      assert.equal(e.netYenPerMonth, e.grossBenefitYenPerMonth - e.monthlyCostYen);
      assert.equal(e.initialCostYen, route.gadgetYen + route.buildDays * 40000);
      assert.equal(e.paybackMonths, e.initialCostYen / e.netYenPerMonth);
      assert.equal(e.annualNetYen, e.netYenPerMonth * 12);
    }
  }
});
test('短縮なしは0に留め、純効果0以下は回収不可', () => {
  const route = { ...catalog.routes[0], residualMinutesPerPrototype: 300, leadDays: 28 };
  const e = computeRouteEconomics(route, catalog.assumptions);
  assert.equal(e.savedMinutesPerPrototype, 0); assert.equal(e.extraPrototypesPerMonth, 0);
  assert.equal(e.netYenPerMonth, -e.monthlyCostYen); assert.equal(e.paybackMonths, null);
  const zero = computeRouteEconomics({ ...route, gadgetYen: 0, consumablesYenPerMonth: 0 }, catalog.assumptions);
  assert.equal(zero.netYenPerMonth, 0); assert.equal(zero.paybackMonths, null);
  assert.equal(computeRouteEconomics(catalog.routes[0], catalog.assumptions, { prototypesPerMonth: 0 }).grossBenefitYenPerMonth, 0);
});
test('初期費用と前提上書き・入力を変更しない', () => {
  const before = clone();
  const report = computeReport(catalog, { ...catalog.assumptions, devDayYen: 100 }, { amortizeMonths: 12 });
  assert.equal(report[0].initialCostYen, 22300); assert.equal(report[0].monthlyGadgetYen, 22000 / 12);
  assert.deepEqual(catalog, before);
});
test('3Dプリンタは純効果最大でも推奨にせず、見積必須・算出不能も除外', () => {
  const report = computeReport(catalog);
  const printer = structuredClone(report.find((r) => r.physicalAI === false));
  printer.netYenPerMonth = 1e9;
  assert.equal(meetsProposalRequirements(printer), false);
  assert.equal(pickRecommendation([printer]), null);
  assert.equal(pickRecommendation([...report, printer]).id, pickRecommendation(report).id);
  const cap = { physicalAI: true, prototypeCycleShortening: true };
  assert.equal(meetsProposalRequirements(cap), true);
  for (const flags of [{ physicalAI: false }, { prototypeCycleShortening: false }, { physicalAI: 'true' }, { prototypeCycleShortening: 1 }]) assert.equal(meetsProposalRequirements({ ...cap, ...flags }), false);
  const candidates = [{ id: 'a', priceVerify: 'primary', netYenPerMonth: 1, ...cap }, { id: 'b', priceVerify: 'assumed', netYenPerMonth: 2, ...cap }];
  assert.equal(pickRecommendation([...candidates, { ...cap, priceVerify: 'quote-required', netYenPerMonth: 1e9 }, { ...cap, priceVerify: 'primary', netYenPerMonth: null }]).id, 'b');
});
test('候補0件ならnullと未取得理由・名前付きID', () => {
  assert.equal(pickRecommendation([]), null);
  const c = clone(); c.routes = [{ ...c.routes[0], priceVerify: 'quote-required', gadgetYen: null, buildDays: null }];
  const report = computeReport(c); assert.equal(pickRecommendation(report), null);
  const md = renderMarkdown(c, report);
  assert.ok(md.includes('導入判断に必要な価格が未取得（見積必須）:'));
  assert.ok(md.includes(`${c.routes[0].label}（${c.routes[0].id}）: 見積必須。`));
});
test('仮定一覧・即時回収・未確認事項・出典・表を表示', () => {
  const c = clone(); c.routes = [{ ...c.routes[0], priceVerify: 'assumed', gadgetYen: 0, buildDays: 0 }];
  const md = renderMarkdown(c, computeReport(c));
  assert.ok(md.includes('この推奨は仮定値に依存する（仮定: prototypesPerMonth'));
  assert.ok(md.includes('so101-diy.gadgetYen')); assert.ok(md.includes('so101-diy.leadDays'));
  assert.ok(md.includes('初期費用0円のため即時'));
  assert.ok(md.includes('demandCaptureRate による追加受注への転換が売上効果の唯一の原資'));
  assert.ok(md.includes('| ルート | 初期費用 | 月額 | 短縮分/件 | 工数削減円/月 | 売上効果円/月 | 純効果円/月 | 回収期間 | 価格の確度 | 物理AI | 試作短縮 |'));
  assert.ok(md.includes('|---|---:|---:|---:|---:|---:|---:|---|---|---|---|'));
  const unverified = md.split('## 見積必須・未確認')[1].split('## 出典')[0];
  for (const [key, fact] of Object.entries(c.facts)) assert.equal(unverified.includes(key), fact.status !== 'verified');
  for (const url of [...Object.values(c.sources), ...c.routes.map((r) => r.priceSource)]) assert.ok(md.includes(url));
  c.assumptions.demandCaptureRate = null;
  assert.ok(renderMarkdown(c, computeReport(c)).includes('計算入力に未取得値（null）'));
});
test('--write生成・見出し順・LF末尾と--check一致/CRLF/改変/欠落', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-ai-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const docPath = path.join(dir, 'docs', 'plan.md');
  const options = { docPath, ...quiet() };
  assert.equal(runPlan({ ...options, args: ['--check'] }), 1);
  assert.equal(runPlan({ ...options, args: ['--write'] }), 0);
  const md = fs.readFileSync(docPath, 'utf8');
  assert.deepEqual(md.split('\n').filter((line) => /^#{1,2} /u.test(line)), headings);
  assert.match(md, /[^\n]\n$/u); assert.ok(!md.includes('\r'));
  assert.equal(runPlan({ ...options, args: ['--check'] }), 0);
  fs.writeFileSync(docPath, md.replace(/\n/gu, '\r\n'));
  assert.equal(runPlan({ ...options, args: ['--check'] }), 0);
  fs.writeFileSync(docPath, `${md}改変\n`);
  let error = '';
  assert.equal(runPlan({ ...options, args: ['--check'], stderr: { write(s) { error += s; } } }), 1);
  assert.match(error, /^drift: /u);
  assert.equal(runPlan({ ...options, args: ['--write'] }), 0);
  assert.equal(runPlan({ ...options, args: ['--check'] }), 0);
});
test('未知引数・競合モード・不正数値は1行エラー', () => {
  for (const args of [['--unknown'], ['--json', '--check'], ['--write', '--write'], ['--prototypes'], ['--prototypes', 'NaN'], ['--prototypes', '-1'], ['--prototypes', 'Infinity'], ['--prototypes', '']]) {
    assert.throws(() => parseCli(args));
    let error = '';
    assert.equal(runPlan({ args, stdout: quiet().stdout, stderr: { write(s) { error += s; } } }), 1);
    assert.equal(error.trimEnd().split('\n').length, 1);
  }
  for (const options of [{ args: ['--demand-capture-rate', '1.5'] }, { overrides: { demandCaptureRate: 1.5 } }, { overrides: { unknown: 1 } }, { overrides: { hourlyYen: null } }, { check: true, json: true }]) assert.equal(runPlan({ ...options, ...quiet() }), 1);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./physical-ai-prototyping-plan.mjs', import.meta.url)), '--json', '--check'], { encoding: 'utf8' });
  assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.match(child.stderr, /^モードは1つだけ指定してください\n$/u);
});
test('8種類のCLI上書きをJSONと感度分析に反映', () => {
  let output = '';
  const args = ['--json', '--prototypes', '2', '--current-lead-days', '12', '--manual-minutes', '300', '--hourly-yen', '3000', '--dev-day-yen', '10000', '--margin-yen', '40000', '--demand-capture-rate', '0.5', '--amortize-months', '12'];
  const expectedAssumptions = { prototypesPerMonth: 2, currentLeadDays: 12, currentManualMinutesPerPrototype: 300, hourlyYen: 3000, devDayYen: 10000, marginYenPerPrototype: 40000, demandCaptureRate: 0.5, amortizeMonths: 12 };
  assert.deepEqual(parseCli(args), { overrides: expectedAssumptions, json: true });
  assert.equal(runPlan({ args, stdout: { write(s) { output += s; } }, stderr: quiet().stderr }), 0);
  const result = JSON.parse(output);
  assert.deepEqual(result.assumptions, expectedAssumptions);
  assert.deepEqual(result.routes, computeReport(catalog, expectedAssumptions));
  assert.deepEqual(result.recommendation, pickRecommendation(result.routes));
  const md = renderMarkdown(catalog, result.routes, result.assumptions);
  for (const route of catalog.routes) {
    const cells = [1, 2, 4, 8, 12].map((prototypesPerMonth) => computeRouteEconomics(route, result.assumptions, { prototypesPerMonth }).netYenPerMonth.toLocaleString('ja-JP', { maximumFractionDigits: 0 }));
    assert.ok(md.includes(`| ${route.label}（${route.id}） | ${cells.join(' | ')} |`));
  }
});
test('カタログ読込エラーと既定Markdown出力', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-ai-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalogPath = path.join(dir, 'catalog.json');
  assert.equal(runPlan({ catalogPath, ...quiet() }), 1);
  fs.writeFileSync(catalogPath, '{'); assert.equal(runPlan({ catalogPath, ...quiet() }), 1);
  fs.writeFileSync(catalogPath, 'null'); assert.equal(runPlan({ catalogPath, ...quiet() }), 1);
  let output = '';
  assert.equal(runPlan({ stdout: { write(s) { output += s; } }, stderr: quiet().stderr }), 0);
  assert.equal(output, renderMarkdown(catalog, computeReport(catalog)));
});
