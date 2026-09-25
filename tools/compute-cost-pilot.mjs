#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isEntry } from './is-entry.mjs';

export function loadCatalog() {
  return JSON.parse(readFileSync(new URL('./compute-cost-catalog.json', import.meta.url), 'utf8'));
}

export function providerCost(provider, profile) {
  const measured = Number.isFinite(provider.fixedUsdMonthly);
  const fixedUsd = measured ? provider.fixedUsdMonthly : null;
  const meters = new Set([...Object.keys(provider.included ?? {}), ...Object.keys(provider.meters ?? {})]);
  const overageLines = [...meters].map((meter) => {
    const quantity = profile[meter] ?? 0;
    const included = provider.included?.[meter] ?? 0;
    const billable = Math.max(0, quantity - included);
    const unitUsd = provider.meters?.[meter] ?? 0;
    return { meter, quantity, included, billable, unitUsd, usd: billable * unitUsd };
  });
  const overageUsd = overageLines.reduce((sum, line) => sum + line.usd, 0);
  const reasons = [];
  if (typeof provider.dailyRequestLimitMillions === 'number' &&
      profile.peakRequestsPerDayMillions > provider.dailyRequestLimitMillions) {
    reasons.push('無料枠の日次上限を超える（無料枠は月間合計では判定できない）');
  }
  if (provider.commercialUse === 'noncommercial-only' && profile.commercial === true) {
    reasons.push('無料枠は非商用限定');
  }
  return {
    providerId: provider.id, vendor: provider.vendor, plan: provider.plan,
    url: provider.url, verified: provider.verified,
    eligible: reasons.length === 0, ineligibleReason: reasons.length ? reasons.join(' / ') : null,
    measured, usd: measured ? fixedUsd + overageUsd : null,
    fixedUsd, overageUsd, overageLines,
  };
}

export function compareWorkload(workload, catalog) {
  const rows = workload.candidates.map((id) => {
    const provider = catalog.providers.find((p) => p.id === id);
    if (!provider) throw new Error(`未知のプロバイダIDです: ${id}（${workload.label}）`);
    return providerCost(provider, { ...workload.profile, commercial: workload.commercial });
  });
  const eligibleRows = rows.filter((r) => r.eligible && r.measured);
  const cheapest = [...eligibleRows].sort((a, b) => a.usd - b.usd)[0] ?? null;
  const current = rows.find((r) => r.providerId === workload.currentProviderId) ?? null;
  const unmeasuredCount = rows.filter((r) => !r.measured).length;
  return {
    workloadId: workload.id, label: workload.label, commercial: workload.commercial,
    rows, eligibleRows, cheapest, current, currentUnknown: !current?.measured,
    savingsUsd: current?.measured && cheapest?.measured ? current.usd - cheapest.usd : null,
    unmeasuredCount, ineligibleCount: rows.filter((r) => !r.eligible).length,
    certainty: unmeasuredCount || rows.some((r) => r.verified === false) ? 'partial' : 'confirmed',
  };
}

const money = (usd) => usd === null ? '**未計測**' : `$${usd.toFixed(2)}`;
const name = (row) => `${row.vendor} ${row.plan}（${row.providerId}）`;
const cell = (value) => String(value).replace(/\|/g, '&#124;').replace(/\r\n|\r|\n/g, '<br>');
const tableRow = (values) => `| ${values.map(cell).join(' | ')} |`;
const warning = (result) => `⚠️ この比較は一部未確定（未計測 ${result.unmeasuredCount} 件）`;

export function summarize(catalog) {
  return [catalog.caveat, ...catalog.workloads.map((workload) => {
    const r = compareWorkload(workload, catalog);
    return `${r.label}: 最安 ${r.cheapest ? `${name(r.cheapest)} ${money(r.cheapest.usd)}/月` : '算定可能な適格候補なし'}` +
      (r.savingsUsd === null ? ' / 削減額: 未算定' : ` / 削減額: ${money(r.savingsUsd)}/月`) +
      (r.certainty === 'partial' ? ` / ${warning(r)}` : '');
  })].join('\n');
}

export function renderMarkdown(catalog) {
  const out = [
    '<!-- このファイルは tools/compute-cost-pilot.mjs --write が生成する。手で編集しない。 -->',
    '# 計算リソースの月額比較', '', catalog.caveat, '',
    `価格基準日: ${catalog.priceAsOf}`, '',
    'カタログに記載された基本料金と従量単価で計算する。未記載の超過単価は式上0として扱うため、実際の無料枠内での利用可否や機能の代替可能性を保証しない。', '',
  ];
  for (const workload of catalog.workloads) {
    const r = compareWorkload(workload, catalog);
    out.push(`## ${cell(r.label)}`, '', `商用利用: ${r.commercial ? 'あり' : 'なし'}`, '',
      '| 前提メーター | 数量 | 単位 |', '| --- | ---: | --- |');
    for (const [meter, quantity] of Object.entries(workload.profile)) {
      out.push(tableRow([meter, quantity, catalog.meterUnits[meter] ??
        (meter === 'peakRequestsPerDayMillions' ? '百万リクエスト/日（ピーク）' : '')]));
    }
    out.push('', '| 候補（ID） | 基本料金/月 | 超過料金/月 | 月額 | verified | 適格性 | 出典 | 注記 |',
      '| --- | ---: | ---: | ---: | --- | --- | --- | --- |');
    for (const row of r.rows) {
      const provider = catalog.providers.find((p) => p.id === row.providerId);
      out.push(tableRow([name(row), money(row.fixedUsd), money(row.overageUsd), money(row.usd),
        row.verified ? '一次情報' : '未確認', row.eligible ? '適格' : `不適格: ${row.ineligibleReason}`,
        row.url, provider.note ?? '']));
    }
    out.push('', `最安: ${r.cheapest ? `${cell(name(r.cheapest))} ${money(r.cheapest.usd)}/月` : '算定可能な適格候補なし'}`);
    if (r.current) out.push(`現行: ${cell(name(r.current))} ${money(r.current.usd)}/月`);
    out.push(`削減額: ${r.savingsUsd === null ? '未算定（現行または最安の金額が不明）' : `${money(r.savingsUsd)}/月`}`);
    if (r.certainty === 'partial') out.push('', `> ${warning(r)}`);
    out.push('');
  }
  return out.join('\n');
}

/** CLIとテストで同じ改行正規化・差分判定を使う。 */
export function compareMarkdown(expected, actual) {
  if (actual === null) return { matches: false, summary: '生成ファイルが存在しない' };
  const normalize = (text) => text.replace(/\r\n/g, '\n');
  const a = normalize(expected), b = normalize(actual);
  if (a === b) return { matches: true, summary: '' };
  const expectedLines = a.split('\n'), actualLines = b.split('\n');
  const first = Array.from({ length: Math.max(expectedLines.length, actualLines.length) }, (_, i) => i)
    .find((i) => expectedLines[i] !== actualLines[i]);
  return { matches: false, summary: `${first + 1}行目から不一致（期待 ${expectedLines.length} 行 / 実際 ${actualLines.length} 行）` };
}

if (isEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !['--json', '--write', '--check'].includes(args[0]))) {
      throw new Error('使用法: compute-cost-pilot.mjs [--json|--write|--check]');
    }
    const catalog = loadCatalog();
    const output = new URL('../docs/compute-cost-pilot.md', import.meta.url);
    if (args[0] === '--json') {
      console.log(JSON.stringify(catalog.workloads.map((w) => compareWorkload(w, catalog)), null, 2));
    } else if (args[0] === '--write') {
      mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
      writeFileSync(output, renderMarkdown(catalog), 'utf8');
      console.log('生成: docs/compute-cost-pilot.md');
    } else if (args[0] === '--check') {
      let actual = null;
      try { actual = readFileSync(output, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const result = compareMarkdown(renderMarkdown(catalog), actual);
      if (!result.matches) {
        console.error(`drift: docs/compute-cost-pilot.md: ${result.summary}。--write で再生成してください。`);
        process.exitCode = 1;
      }
    } else {
      console.log(summarize(catalog));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
