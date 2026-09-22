#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from './env-kv.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepo = path.dirname(path.dirname(scriptPath));
const fixedKinds = new Set(['seat', 'plan', 'prepaid']);
const yen = (value) => value === null ? '未記入' : `¥${Math.round(value).toLocaleString('ja-JP')}`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function loadCatalog(repoRoot = defaultRepo) {
  return readJson(path.join(repoRoot, 'tools', 'ai-subscription-catalog.json'));
}

export function extractWiringProviders(source) {
  // PROVIDERS のトップレベル終端だけを使い、内側のオブジェクトや後続の定数を除外する。
  const block = source.match(/^const PROVIDERS = \{\r?\n([\s\S]*?)^\};/m);
  return block ? [...block[1].matchAll(/^\s{2}([a-z][a-z0-9]*):\s*\{/gm)].map((match) => match[1]) : [];
}

export function collectKeyInventory(home) {
  const directory = path.join(home, '.claude');
  let files;
  try { files = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter((item) => item.isFile() && item.name.endsWith('.env'))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map((item) => ({ file: item.name, keys: Object.keys(parseEnvText(fs.readFileSync(path.join(directory, item.name), 'utf8'))).sort() }));
}

export function collectUsageByProvider(home) {
  let source;
  try { source = fs.readFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const counts = new Map();
  for (const line of source.split(/\r?\n/)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row?.provider === 'string' && row.provider) counts.set(row.provider, (counts.get(row.provider) || 0) + 1);
  }
  return Object.fromEntries(counts);
}

function monthlyCost(jpy, usd, usdJpy) {
  if (typeof jpy === 'number' && Number.isFinite(jpy) && jpy >= 0) return jpy;
  if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 && typeof usdJpy === 'number' && usdJpy > 0 && Number.isFinite(usdJpy)) return usd * usdJpy;
  return null;
}

export function analyzeInventory({ catalog, fixedConfig, billing, wiringProviders, keyInventory, usageByProvider }) {
  const findings = [];
  const add = (id, severity, serviceIds, detail) => findings.push({ id, severity, serviceIds, detail });
  const services = catalog.services.map((item) => {
    const fixed = (fixedConfig.fixed || []).find((row) => row.id === item.id || row.name === item.name
      || row.name?.startsWith(`${item.name} (`) || (item.id === 'gemini' && row.name === 'Gemini autopay 上限'));
    const monthlyJpy = fixed ? monthlyCost(fixed.jpy, fixed.usd, fixedConfig.usdJpy)
      : monthlyCost(item.monthlyJpy, item.monthlyUsd, fixedConfig.usdJpy);
    const actual = keyInventory.filter((entry) => entry.keys.some((key) => item.keyEnvs.includes(key)));
    const billingRow = billing[item.id] ?? (item.id === 'grok' ? billing.xai : undefined);
    const kind = fixed?.kind ?? (billingRow?.billing === 'prepaid' ? 'prepaid' : billingRow?.billing === 'postpaid' ? 'metered' : item.kind);
    return { id: item.id, name: item.name, vendor: item.vendor, kind, capabilities: [...item.capabilities], monthlyJpy,
      costKnown: monthlyJpy !== null, keyFiles: [...new Set(actual.map((entry) => entry.file))].sort(),
      keysFound: [...new Set(actual.flatMap((entry) => entry.keys.filter((key) => item.keyEnvs.includes(key))))].sort(),
      usageCount: Object.hasOwn(usageByProvider, item.id) ? usageByProvider[item.id] : 0,
      wired: wiringProviders.includes(item.id), billingVerified: billingRow?.verified ?? null };
  });
  const unknown = new Set();
  let confirmedJpy = 0;
  let candidateJpy = 0;
  for (const service of services) {
    const ids = [service.id];
    const label = `${service.name} (${service.id})`;
    for (const key of service.keysFound) {
      const files = new Set(keyInventory.filter((entry) => entry.keys.includes(key)).map((entry) => entry.file));
      if (files.size >= 2) add('duplicate-account', 'warn', ids, `${label}: ${key} が ${files.size} 本に存在（${[...files].sort().join(', ')}）。キー名の重複であり契約数は未確認`);
    }
    for (const capability of service.capabilities) {
      if (!Object.hasOwn(catalog.capabilities, capability)) add('unknown-capability', 'error', ids, `${label}: 未知の用途 ${capability}`);
    }
    if (fixedKinds.has(service.kind) && !service.costKnown) add('unfilled-cost', 'warn', ids, `${label}: 月額未記入、棚卸し未完`);
    // executor-usage.jsonl が観測するのは実行レーン（llm-ask / codex）だけ。Claude Code 本体や IDE アプリの
    // 利用は台帳に載らないため、配線も課金情報も無いサービスを「実使用ゼロ」と断定すると誤判定になる。
    const observable = service.wired || service.billingVerified !== null;
    if (observable && service.usageCount === 0 && service.kind !== 'metered') {
      add('unused-service', 'warn', ids, `${label}: 実行レーンに配線済みだが実使用ゼロ＝解約候補`);
      if (service.costKnown) confirmedJpy += service.monthlyJpy;
      else unknown.add(service.id);
    } else if (!observable && service.usageCount === 0 && service.kind !== 'metered') {
      add('usage-unknown', 'info', ids, `${label}: 実使用を台帳で観測できない（実行レーン外）。契約条件は手動で確認`);
    }
    if (service.billingVerified === false) add('unverified-billing', 'info', ids, `${label}: 課金設定が未検証`);
  }
  for (const [capability, name] of Object.entries(catalog.capabilities)) {
    const group = services.filter((service) => fixedKinds.has(service.kind) && service.capabilities.includes(capability));
    if (group.length < 2) continue;
    add('duplicate-capability', 'warn', group.map((service) => service.id), `${name} (${capability}) が固定費 ${group.length} サービスで重複: ${group.map((service) => `${service.name} (${service.id})`).join(', ')}`);
    const missing = group.filter((service) => !service.costKnown);
    if (missing.length) {
      missing.forEach((service) => unknown.add(service.id));
      candidateJpy = null;
    } else if (candidateJpy !== null) {
      const costs = group.map((service) => service.monthlyJpy);
      candidateJpy += costs.reduce((sum, cost) => sum + cost, 0) - Math.min(...costs);
    }
  }
  // 非AIのキー（GROWI / WordPress / PRTIMES 等）まで拾うと info が数十件になり、信号として使えなくなる。
  // AIベンダー名で始まる env ファイルだけを対象にし、棚卸し表への登録漏れだけを報告する。
  const declared = new Set(catalog.services.flatMap((service) => service.keyEnvs));
  const prefixes = catalog.aiVendorPrefixes || [];
  for (const entry of keyInventory) {
    if (!prefixes.some((prefix) => entry.file.toLowerCase().startsWith(prefix))) continue;
    for (const key of entry.keys) {
      // URL・リージョン・表示名は「契約」ではないので対象外。認証情報らしい名前だけを拾う。
      if (declared.has(key) || /_(?:BASE|URL|HOST|REGION|LABEL|ID|NAME)$/.test(key)) continue;
      add('uncatalogued-key', 'info', [], `${entry.file}: ${key} はカタログ未登録＝棚卸し漏れの疑い`);
    }
  }
  const counts = { services: services.length, fixed: services.filter((service) => fixedKinds.has(service.kind)).length,
    warn: findings.filter((item) => item.severity === 'warn').length,
    info: findings.filter((item) => item.severity === 'info').length,
    error: findings.filter((item) => item.severity === 'error').length };
  return { generatedAt: new Date().toISOString(), usdJpy: fixedConfig.usdJpy, monthlyBudgetJpy: fixedConfig.monthlyBudgetJpy,
    services, findings, savings: { confirmedJpy, candidateJpy, unknownCount: unknown.size }, counts, ok: counts.error === 0 };
}

function listLines(report) {
  const fixed = report.services.filter((service) => fixedKinds.has(service.kind));
  return [...report.services.map((service) => `${service.id} ${service.kind} ${service.capabilities.join(',')} ${yen(service.monthlyJpy)} keys:${service.keyFiles.length} 使用:${service.usageCount}`),
    `合計: ${report.counts.services} サービス / 固定費 ${fixed.length} 件 / 判明月額 ${yen(fixed.reduce((sum, service) => sum + (service.monthlyJpy ?? 0), 0))} / 金額不明 ${fixed.filter((service) => !service.costKnown).length} 件（cap 除外）`];
}

function savingsLines(report) {
  return [`確実: ${yen(report.savings.confirmedJpy)}`, `統合候補: ${report.savings.candidateJpy === null ? '算定不能（金額不明を含む）' : yen(report.savings.candidateJpy)}`,
    `金額不明 ${report.savings.unknownCount} 件`, '統合候補は用途グループ別の試算合計。同じサービスが複数用途に属するため重複し得る。確実分とも合算しない。',
    '実使用は executor-usage.jsonl の記録範囲。解約前に台帳外の利用と契約条件を確認する。'];
}

export function formatReport(report) {
  return [...listLines(report), '', '検出した問題', ...report.findings.map((item) => `${item.severity.toUpperCase()} ${item.id}: ${item.detail}`), '', '削減見込み', ...savingsLines(report)].join('\n');
}

export function renderDoc(report, catalog) {
  const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const lines = ['<!-- tools/ai-subscription-catalog.json から tools/ai-subscription-inventory.mjs --write で生成。手で編集しない。 -->',
    '', '# AIサブスクリプション棚卸し・統合提案', '', catalog.purpose, '', '## 一覧', '',
    '| サービス | ベンダー | 課金形態 | 月額 | キー | 実使用 |', '| --- | --- | --- | --- | --- | --- |',
    ...report.services.map((service) => `| ${[`${service.name} (${service.id})`, service.vendor, service.kind, `${yen(service.monthlyJpy)}${service.kind === 'cap' ? '（上限・固定費除外）' : ''}`, service.keyFiles.join(', ') || '未検出', service.usageCount].map(cell).join(' | ')} |`),
    '', '## 検出した問題', ''];
  for (const severity of ['error', 'warn', 'info']) {
    for (const item of report.findings.filter((finding) => finding.severity === severity)) lines.push(`- [${severity}] ${item.detail}`);
  }
  if (!report.findings.length) lines.push('問題なし');
  lines.push('', '## 削減見込み', '', ...savingsLines(report).map((line) => `- ${line}`), '', '## 統合・解約の進め方', '',
    '- 金額不明を埋める。budget-fixed.json の固定費を更新する。',
    '- 重複キーを1本に統合する。利用者と参照先を確認して切り替える。',
    '- 実使用ゼロの固定費を解約する。台帳外の利用と契約条件を確認する。',
    '- 四半期ごとに再実行する。実使用と費用を再確認する。');
  return `${lines.join('\n').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trimEnd()}\n`;
}

const usage = 'usage: node tools/ai-subscription-inventory.mjs [--list|--check [--strict]|--json|--write] [--home <dir>] [--repo <dir>]';
export function main(args = process.argv.slice(2)) {
  let home = os.homedir(), repoRoot = defaultRepo, mode, strict = false;
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (['--list', '--check', '--json', '--write'].includes(arg)) {
        if (mode) throw new Error('モードは1つだけ指定してください');
        mode = arg;
      } else if (arg === '--strict') strict = true;
      else if (arg === '--home' || arg === '--repo') {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} にディレクトリが必要です`);
        if (arg === '--home') home = path.resolve(value); else repoRoot = path.resolve(value);
      } else throw new Error(`未知の引数: ${arg}`);
    }
    if (strict && mode !== '--check') throw new Error('--strict は --check と併用してください');
  } catch (error) { console.error(`${error.message}\n${usage}`); return 2; }
  try {
    const catalog = loadCatalog(repoRoot);
    const report = analyzeInventory({ catalog, fixedConfig: readJson(path.join(repoRoot, 'tools', 'budget-fixed.json')),
      billing: readJson(path.join(repoRoot, 'tools', 'provider-billing.json')),
      wiringProviders: extractWiringProviders(fs.readFileSync(path.join(repoRoot, 'tools', 'llm-ask.mjs'), 'utf8')),
      keyInventory: collectKeyInventory(home), usageByProvider: collectUsageByProvider(home) });
    if (mode === '--write') {
      const file = path.join(repoRoot, 'docs', 'ai-subscription-consolidation.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, renderDoc(report, catalog), 'utf8');
      console.log('wrote docs/ai-subscription-consolidation.md');
    } else if (mode === '--json') console.log(JSON.stringify(report, null, 2));
    else if (mode === '--list') console.log(listLines(report).join('\n'));
    else if (mode === '--check') {
      for (const item of report.findings) console.log(`${item.severity.toUpperCase()} ${item.id}: ${item.detail}`);
      const failures = report.counts.error + (strict ? report.counts.warn : 0);
      console.log(failures ? `要対応 ${failures}件` : 'ok');
      return failures ? 1 : 0;
    } else console.log(formatReport(report));
    return 0;
  } catch {
    // env の内容や JSON パース断片が例外経由で漏れないよう、入力値を出力しない。
    console.error('棚卸しに失敗しました。入力ファイルの存在・権限・形式を確認してください。');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) process.exitCode = main();
