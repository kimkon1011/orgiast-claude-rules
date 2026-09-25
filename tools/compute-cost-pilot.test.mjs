import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCatalog, providerCost, compareWorkload, summarize, renderMarkdown, compareMarkdown } from './compute-cost-pilot.mjs';

const catalog = loadCatalog();
const provider = (id) => catalog.providers.find((p) => p.id === id);
const paid = provider('cloudflare-workers-paid');
const workload = (candidates, extra = {}) => ({ id: 'test', label: 'テスト', profile: {}, commercial: false, candidates, ...extra });

test('全providerが必須識別情報を持つ', () => {
  for (const p of catalog.providers) for (const key of ['id', 'vendor', 'plan', 'url']) {
    assert.equal(typeof p[key], 'string');
    assert.ok(p[key].length > 0);
  }
});
test('一次情報確認済みproviderの基本料金が有限数', () => {
  for (const p of catalog.providers.filter((p) => p.verified)) assert.ok(Number.isFinite(p.fixedUsdMonthly));
});
test('includedとmetersは定義済み単位だけを使う', () => {
  for (const p of catalog.providers) for (const key of [...Object.keys(p.included), ...Object.keys(p.meters)]) {
    assert.ok(Object.hasOwn(catalog.meterUnits, key), `${p.id}: ${key}`);
  }
});
test('全候補が実在するproviderを参照する', () => {
  for (const w of catalog.workloads) for (const id of w.candidates) assert.ok(provider(id));
});
test('20百万リクエストの基本料金と超過料金を計算する', () => {
  const r = providerCost(paid, { requests: 20 });
  assert.equal(r.usd, 8);
  assert.equal(r.fixedUsd, 5);
  assert.equal(r.overageUsd, 3);
  assert.deepEqual(r.overageLines[0], { meter: 'requests', quantity: 20, included: 10, billable: 10, unitUsd: 0.3, usd: 3 });
});
test('同梱枠内では基本料金だけになる', () => {
  const r = providerCost(paid, { requests: 5 });
  assert.equal(r.usd, 5);
  assert.equal(r.overageUsd, 0);
});
test('未計測はnullとなり集計対象に入らない', () => {
  for (const fixedUsdMonthly of [null, undefined, '5', NaN, Infinity, -Infinity]) {
    const p = { ...paid, id: 'unknown', fixedUsdMonthly, verified: false };
    const r = providerCost(p, { requests: 20 });
    assert.equal(r.measured, false);
    assert.equal(r.usd, null);
    assert.equal(r.fixedUsd, null);
    const c = { ...catalog, providers: [p, paid] };
    const comparison = compareWorkload(workload(['unknown', paid.id], { currentProviderId: 'unknown' }), c);
    assert.deepEqual(comparison.eligibleRows.map((row) => row.providerId), [paid.id]);
    assert.equal(comparison.eligibleRows.reduce((total, row) => total + row.usd, 0), 5);
    assert.equal(comparison.unmeasuredCount, 1);
    assert.equal(comparison.savingsUsd, null);
    assert.equal(comparison.currentUnknown, true);
    assert.equal(comparison.certainty, 'partial');
  }
});
test('無料枠の日次ピーク超過は金額を維持し不適格になる', () => {
  const p = provider('cloudflare-workers-free');
  const r = providerCost(p, { requests: 0.2, peakRequestsPerDayMillions: 0.10001 });
  assert.equal(r.eligible, false);
  assert.equal(r.usd, 0);
  assert.equal(r.ineligibleReason, '無料枠の日次上限を超える（無料枠は月間合計では判定できない）');
  assert.equal(providerCost(p, { peakRequestsPerDayMillions: 0.1 }).eligible, true);
});
test('Hobbyは商用workloadで不適格になる', () => {
  const r = compareWorkload(workload(['vercel-hobby', paid.id], { commercial: true }), catalog);
  assert.equal(r.rows[0].eligible, false);
  assert.equal(r.rows[0].ineligibleReason, '無料枠は非商用限定');
  assert.equal(r.rows[0].usd, 0);
  assert.equal(r.cheapest.providerId, paid.id);
  assert.equal(r.ineligibleCount, 1);
  assert.equal(providerCost(provider('vercel-hobby'), { commercial: false }).eligible, true);
});
test('現行が不明な場合の削減額はnull', () => {
  const r = compareWorkload(workload([paid.id]), catalog);
  assert.equal(r.current, null);
  assert.equal(r.currentUnknown, true);
  assert.equal(r.savingsUsd, null);
});
test('Markdownは決定的で入力を変更せず必須情報を含む', () => {
  const before = JSON.stringify(catalog);
  const md = renderMarkdown(catalog);
  assert.equal(md, renderMarkdown(catalog));
  assert.equal(JSON.stringify(catalog), before);
  assert.ok(md.startsWith('<!--'));
  assert.ok(md.includes(catalog.caveat));
  for (const text of ['一次情報', '未確認', '$5.00', '⚠️ この比較は一部未確定（未計測 0 件）', 'peakRequestsPerDayMillions']) assert.ok(md.includes(text));
});
test('CRLFだけの差はdriftではなく、実差分と欠損はdriftになる', () => {
  assert.equal(compareMarkdown('a\nb\n', 'a\r\nb\r\n').matches, true);
  assert.equal(compareMarkdown('a\nb\n', 'a\nc\n').matches, false);
  assert.match(compareMarkdown('a\nb\n', 'a\nc\n').summary, /2行目/);
  assert.equal(compareMarkdown('a\n', null).matches, false);
});
test('候補順を保ち、同額なら先の候補を最安にする', () => {
  const ids = ['github-pages-free', 'cloudflare-workers-free', paid.id];
  const r = compareWorkload(workload(ids, { currentProviderId: paid.id }), catalog);
  assert.deepEqual(r.rows.map((row) => row.providerId), ids);
  assert.equal(r.cheapest.providerId, ids[0]);
  assert.equal(r.savingsUsd, 5);
  assert.equal(r.certainty, 'partial');
  assert.equal(compareWorkload(workload([paid.id]), catalog).certainty, 'confirmed');
});
test('適格候補なしでは最安と削減額がnull', () => {
  const r = compareWorkload(workload(['vercel-hobby'], { commercial: true, currentProviderId: 'vercel-hobby' }), catalog);
  assert.equal(r.cheapest, null);
  assert.equal(r.savingsUsd, null);
  assert.equal(r.currentUnknown, false);
});
test('複数メーターの超過を加算する', () => {
  assert.equal(providerCost(paid, { requests: 20, cpuMs: 40 }).usd, 8.2);
});
test('未計測表示とセル内パイプ・改行のエスケープ', () => {
  const p = { ...paid, vendor: 'A|B\nC', fixedUsdMonthly: null, note: 'D|E\r\nF' };
  const c = { ...catalog, providers: [p], workloads: [workload([p.id])] };
  const md = renderMarkdown(c);
  assert.ok(md.includes('A&#124;B<br>C'));
  assert.ok(md.includes('D&#124;E<br>F'));
  assert.ok(md.includes('**未計測**'));
  assert.ok(md.includes('未計測 1 件'));
  assert.ok(summarize(c).includes('算定可能な適格候補なし'));
});
test('実リポジトリの生成docにdriftがない', () => {
  const actual = readFileSync(new URL('../docs/compute-cost-pilot.md', import.meta.url), 'utf8');
  assert.equal(compareMarkdown(renderMarkdown(catalog), actual).matches, true);
});
test('CLIは欠損・差分を終了1、生成後とCRLFを終了0で扱う', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compute-cost-pilot-'));
  try {
    mkdirSync(join(dir, 'tools'));
    for (const file of ['compute-cost-pilot.mjs', 'compute-cost-catalog.json', 'is-entry.mjs']) {
      copyFileSync(new URL(file, import.meta.url), join(dir, 'tools', file));
    }
    const run = (...args) => spawnSync(process.execPath, [join(dir, 'tools/compute-cost-pilot.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
    const missing = run('--check');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /存在しない/);
    assert.equal(run('--write').status, 0);
    assert.equal(run('--check').status, 0);
    const doc = join(dir, 'docs/compute-cost-pilot.md');
    writeFileSync(doc, renderMarkdown(catalog).replace(/\n/g, '\r\n'));
    assert.equal(run('--check').status, 0);
    writeFileSync(doc, 'stale\n');
    const drift = run('--check');
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /drift:.*1行目/);
    const summary = run();
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /最安/);
    const json = run('--json');
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), catalog.workloads.map((w) => compareWorkload(w, catalog)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
