import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeRouteEconomics, computeReport, pickRecommendation, renderMarkdown, runPlan, validateCatalog } from './voice-local-llm-plan.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('./voice-local-llm-catalog.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(catalog);
const quiet = () => ({ stdout: { write() {} }, stderr: { write() {} } });
const headings = ['# 低価格ハードウェア上の音声制御ローカルLLM導入 ルート比較（P-0136）', '## 結論', '## ルート比較', '## 感度分析', '## 音声サテライト＋ローカルLLMホストの実装スケッチ', '## 前提（仮定であり実測ではない）', '## 見積必須・未確認', '## 出典'];

test('正常カタログ', () => assert.deepEqual(validateCatalog(catalog), []));
test('要件未達ルートの理由欠落・空文字・不正型を拒否', () => {
  for (const original of catalog.routes.filter((r) => !r.voiceControl || !r.localLLM)) {
    for (const value of [undefined, '', '  ', null, 0]) {
      const c = clone();
      const route = c.routes.find((r) => r.id === original.id);
      if (value === undefined) delete route.requirementFailReason;
      else route.requirementFailReason = value;
      assert.ok(validateCatalog(c).some((e) => e.includes(`${route.id}.requirementFailReason`)));
    }
  }
});
test('要件を満たすルートへの理由付与を拒否', () => {
  for (const value of [catalog.routes[1].requirementFailReason, '', undefined]) {
    const c = clone();
    Object.assign(c.routes[1], { voiceControl: true, localLLM: true, requirementFailReason: value });
    assert.ok(validateCatalog(c).some((e) => e.includes('requirementFailReason')));
  }
});
test('音声制御またはローカルLLMを欠くルートは理由が必須', () => {
  for (const flags of [{ voiceControl: false, localLLM: true }, { voiceControl: true, localLLM: false }, { voiceControl: false, localLLM: false }]) {
    const c = clone();
    Object.assign(c.routes[0], flags);
    assert.ok(validateCatalog(c).some((e) => e.includes('requirementFailReason')));
    c.routes[0].requirementFailReason = '必須機能がないため。';
    assert.deepEqual(validateCatalog(c), []);
  }
});
test('結論に要件未達3ルートの名前付きIDと理由を表示', () => {
  const md = renderMarkdown(catalog, computeReport(catalog));
  const conclusion = md.split('## 結論\n')[1].split('## ルート比較')[0];
  const lines = conclusion.trim().split('\n');
  const prefix = '- 必須要件（音声制御かつローカルLLM）を満たさないため推奨対象外: ';
  const excluded = catalog.routes.filter((r) => !r.voiceControl || !r.localLLM);
  assert.equal(excluded.length, 3);
  const expected = prefix + excluded.map((r) => `${r.label}（${r.id}）＝${r.requirementFailReason}`).join('、');
  assert.equal(lines[lines.findIndex((line) => line.startsWith('- 推奨は')) + 1], expected);
});
test('要件未達ルートが0件なら推奨対象外の行を出さない', () => {
  const c = clone();
  c.routes = c.routes.filter((r) => r.voiceControl && r.localLLM);
  assert.deepEqual(validateCatalog(c), []);
  assert.ok(!renderMarkdown(c, computeReport(c)).includes('必須要件（音声制御かつローカルLLM）を満たさないため推奨対象外:'));
});
test('感度分析の件数は操作件数と明示', () => {
  const sensitivity = renderMarkdown(catalog, computeReport(catalog)).split('## 感度分析')[1].split('## 音声サテライト')[0];
  assert.ok(sensitivity.includes('純効果円/月の試算。操作件数（opsPerMonth）・手作業と残作業の時間差・人件費単価の仮定が削減額を支配し、クラウド単価がAPI削減額と月額を左右する（実測ではない）。'));
});
test('見積必須ルートに金額を入れると拒否', () => {
  for (const key of ['fixedYen', 'licenseYenPerMonth']) {
    const c = clone(); Object.assign(c.routes[1], { priceVerify: 'quote-required', fixedYen: null, licenseYenPerMonth: null, [key]: 0 });
    assert.ok(validateCatalog(c).some((e) => e.includes('quote-required')));
  }
});
test('secondary の出典欠落を拒否', () => {
  const c = clone(); c.routes[0].priceVerify = 'secondary'; delete c.routes[0].priceSource;
  assert.ok(validateCatalog(c).some((e) => e.includes('priceSource')));
});
test('構造・重複・不正数値・前提欠落を拒否', () => {
  for (const mutate of [
    (c) => { c.version = 2; }, (c) => { c.priceAsOf = ''; }, (c) => { c.proposalId = ''; },
    (c) => { c.routes = []; }, (c) => { c.routes[1].id = c.routes[0].id; },
    (c) => { delete c.routes[0].id; }, (c) => { delete c.routes[0].label; },
    (c) => { c.routes[0].priceVerify = 'unknown'; }, (c) => { delete c.assumptions.hourlyYen; },
    ...[NaN, Infinity, -1, '3', undefined].map((v) => (c) => { c.routes[0].buildDays = v; }),
    (c) => { delete c.assumptions; },
    ...['voiceControl', 'localLLM'].flatMap((key) => [
      (c) => { delete c.routes[0][key]; },
      ...[null, 0, 1, 'true', undefined].map((v) => (c) => { c.routes[0][key] = v; }),
    ]),
    ...Object.keys(catalog.assumptions).flatMap((key) => [NaN, Infinity, -1, '3', undefined].map((v) => (c) => { c.assumptions[key] = v; })),
    ...['gadgetYen', 'buildDays', 'powerYenPerMonth', 'residualMinutesPerOp'].flatMap((key) => [NaN, Infinity, -1, '3', undefined].map((v) => (c) => { c.routes[0][key] = v; })),
  ]) { const c = clone(); mutate(c); assert.ok(validateCatalog(c).length > 0); }
  assert.ok(validateCatalog(null).length > 0);
});
test('未取得値は金額・純効果・回収にnullを伝播する', () => {
  for (const [key, output] of [['gadgetYen', 'initialCostYen'], ['buildDays', 'initialCostYen'], ['powerYenPerMonth', 'monthlyCostYen'], ['residualMinutesPerOp', 'netYenPerMonth']]) {
    const e = computeRouteEconomics({ ...catalog.routes[0], [key]: null }, catalog.assumptions);
    assert.equal(e[output], null); assert.equal(e.paybackMonths, null);
  }
  const e = computeRouteEconomics(catalog.routes[0], { ...catalog.assumptions, hourlyYen: null });
  assert.equal(e.netYenPerMonth, null); assert.equal(e.annualNetYen, null);
});
test('ローカルLLMはクラウド従量0・削減額は操作数×単価', () => {
  for (const r of catalog.routes.filter((r) => r.localLLM)) {
    const e = computeRouteEconomics(r, catalog.assumptions);
    assert.equal(e.cloudYenPerOp, 0); assert.equal(e.cloudSpendYenPerMonth, 0);
    assert.equal(e.cloudSavedYenPerMonth, 1500); assert.equal(e.monthlyCostYen, r.powerYenPerMonth);
    assert.equal(e.baselineHoursPerMonth, 5);
    assert.equal(e.residualHoursPerMonth, 150 * r.residualMinutesPerOp / 60);
    assert.equal(e.netYenPerMonth, e.savedHoursPerMonth * 2500 + 1500 - r.powerYenPerMonth);
    assert.equal(e.annualNetYen, e.netYenPerMonth * 12);
  }
});
test('クラウド系は削減額0・月額に操作数×単価を加算', () => {
  for (const r of catalog.routes.filter((r) => !r.localLLM)) {
    const e = computeRouteEconomics(r, catalog.assumptions);
    assert.equal(e.cloudYenPerOp, 10); assert.equal(e.cloudSpendYenPerMonth, 1500);
    assert.equal(e.cloudSavedYenPerMonth, 0); assert.equal(e.monthlyCostYen, r.powerYenPerMonth + 1500);
    assert.equal(e.netYenPerMonth, e.laborSavedYenPerMonth - e.monthlyCostYen);
  }
});
test('クラウド単価nullは依存する計算だけに伝播する', () => {
  for (const r of catalog.routes) {
    const e = computeRouteEconomics(r, catalog.assumptions, { cloudYenPerOp: null });
    assert.equal(e.monthlyCostYen, r.localLLM ? r.powerYenPerMonth : null);
    assert.equal(e.cloudSavedYenPerMonth, r.localLLM ? null : 0);
    assert.equal(e.netYenPerMonth, null);
  }
});
test('負の削減・純効果を保存し回収不可を返す', () => {
  const e = computeRouteEconomics({ ...catalog.routes[0], residualMinutesPerOp: 10 }, catalog.assumptions);
  assert.ok(e.savedHoursPerMonth < 0); assert.ok(e.netYenPerMonth < 0); assert.equal(e.paybackMonths, null);
});
test('初期費用と回収期間の計算', () => {
  const e = computeRouteEconomics(catalog.routes[0], catalog.assumptions, { devDayYen: 100 });
  assert.equal(e.initialCostYen, 8300);
  assert.equal(e.paybackMonths, 8300 / e.netYenPerMonth);
});
test('推奨は見積必須と要件未達を除き純効果最大', () => {
  const report = computeReport(catalog);
  assert.equal(pickRecommendation([...report, { id: 'excluded', priceVerify: 'quote-required', netYenPerMonth: 1e9, voiceControl: true, localLLM: true }]).id, 'minipc-local');
  const cap = { voiceControl: true, localLLM: true };
  assert.equal(pickRecommendation([{ id: 'a', priceVerify: 'primary', netYenPerMonth: 1, ...cap }, { id: 'b', priceVerify: 'assumed', netYenPerMonth: 2, ...cap }]).id, 'b');
  // ローカルLLMまたは音声制御が無い候補は純効果最大でも推奨しない。
  for (const key of ['voiceControl', 'localLLM']) {
    const excluded = { id: 'excluded', priceVerify: 'primary', netYenPerMonth: 1e9, ...cap, [key]: false };
    assert.equal(pickRecommendation([excluded]), null);
    assert.equal(pickRecommendation([...report, excluded]).id, 'minipc-local');
  }
  assert.equal(pickRecommendation([{ ...report[0], netYenPerMonth: null }]), null);
  assert.equal(pickRecommendation([{ id: 'saas', priceVerify: 'primary', netYenPerMonth: 1e9, voiceControl: false, localLLM: false }]), null);
});
test('候補0件ならnullと未取得理由・名前付きID', () => {
  assert.equal(pickRecommendation([]), null);
  const c = clone(); c.routes = c.routes.map((r) => ({ ...r, priceVerify: 'quote-required', fixedYen: null, licenseYenPerMonth: null }));
  const report = computeReport(c); assert.equal(pickRecommendation(report), null);
  const md = renderMarkdown(c, report, c.assumptions);
  assert.ok(md.includes('導入判断に必要な価格が未取得（見積必須）:'));
  for (const r of c.routes) assert.ok(md.includes(`${r.label}（${r.id}）`));
});
test('仮定推奨にキー一覧、即時回収、未確認事項を表示', () => {
  const c = clone(); c.routes[0].priceVerify = 'assumed';
  const md = renderMarkdown(c, computeReport(c), c.assumptions);
  assert.ok(md.includes('この推奨は仮定値に依存する（仮定: opsPerMonth'));
  assert.ok(md.includes('minipc-local.gadgetYen'));
  assert.ok(md.includes('asrQualityDecidesUsability'));
  const zero = clone(); Object.assign(zero.routes.find((r) => r.id === 'minipc-local'), { buildDays: 0, gadgetYen: 0 });
  assert.ok(renderMarkdown(zero, computeReport(zero), zero.assumptions).includes('初期費用0円のため即時'));
});
test('--write生成・見出し順・LF末尾と--check一致/CRLF/改変/欠落', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-plan-'));
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
  for (const args of [['--unknown'], ['--json', '--check'], ['--write', '--write'], ['--ops'], ['--ops', 'NaN'], ['--ops', '-1'], ['--ops', 'Infinity'], ['--ops', '']]) {
    let error = '';
    assert.equal(runPlan({ args, stdout: quiet().stdout, stderr: { write(s) { error += s; } } }), 1);
    assert.equal(error.trimEnd().split('\n').length, 1);
  }
});
test('5種類のCLI上書きをJSONと感度分析に反映', () => {
  let output = '';
  const args = ['--json', '--ops', '100', '--manual-minutes', '6', '--hourly-yen', '3000', '--cloud-yen-per-op', '8', '--dev-day-yen', '10000'];
  assert.equal(runPlan({ args, stdout: { write(s) { output += s; } }, stderr: quiet().stderr }), 0);
  const result = JSON.parse(output);
  assert.deepEqual(result.assumptions, { opsPerMonth: 100, manualMinutesPerOp: 6, hourlyYen: 3000, cloudYenPerOp: 8, devDayYen: 10000 });
  assert.equal(result.routes[4].cloudYenPerOp, 8);
  const md = renderMarkdown(catalog, result.routes, result.assumptions);
  assert.equal(result.routes[0].cloudSavedYenPerMonth, 800);
  assert.equal(result.routes[0].initialCostYen, 38000);
  const sensitivity = md.split('## 感度分析')[1].split('## 音声サテライト')[0];
  for (const r of catalog.routes) {
    const expected = [50, 100, 200, 400].map((ops) => {
      const labor = ops * (6 - r.residualMinutesPerOp) / 60 * 3000;
      return (labor + (r.localLLM ? ops * 8 : -ops * 8) - r.powerYenPerMonth).toLocaleString('ja-JP', { maximumFractionDigits: 0 });
    });
    assert.ok(sensitivity.includes(`| ${r.label}（${r.id}） | ${expected.join(' | ')} |`));
  }
});
test('実リポジトリの生成docにdriftがない', () => assert.equal(runPlan({ check: true, ...quiet() }), 0));
