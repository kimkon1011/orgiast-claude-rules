#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return ['catalog はオブジェクトでなければなりません'];
  if (catalog.version !== 1) errors.push('version は 1 でなければなりません');
  if (typeof catalog.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(catalog.updatedAt)) errors.push('updatedAt は YYYY-MM-DD 形式でなければなりません');
  if (!Array.isArray(catalog.domains)) errors.push('domains は配列でなければなりません');
  if (!Array.isArray(catalog.processes)) errors.push('processes は配列でなければなりません');
  if (errors.length) return errors;

  const domainKeys = new Set();
  for (const [index, domain] of catalog.domains.entries()) {
    if (!domain || typeof domain !== 'object' || typeof domain.key !== 'string' || !domain.key || typeof domain.label !== 'string' || !domain.label) {
      errors.push(`domains[${index}] の key と label は必須です`);
      continue;
    }
    if (domainKeys.has(domain.key)) errors.push(`domain key が重複しています: ${domain.key}`);
    domainKeys.add(domain.key);
  }

  const ids = new Set();
  for (const [index, process] of catalog.processes.entries()) {
    if (!process || typeof process !== 'object') {
      errors.push(`processes[${index}] はオブジェクトでなければなりません`);
      continue;
    }
    for (const field of ['id', 'domain', 'name', 'manualRemainder', 'evidence']) {
      if (typeof process[field] !== 'string' || !process[field]) errors.push(`processes[${index}].${field} は必須です`);
    }
    if (typeof process.id === 'string') {
      if (ids.has(process.id)) errors.push(`id が重複しています: ${process.id}`);
      ids.add(process.id);
    }
    if (typeof process.domain === 'string' && !domainKeys.has(process.domain)) errors.push(`domains に無い domain です: ${process.id || index} -> ${process.domain}`);
    if (!process.owner || typeof process.owner !== 'object' || Array.isArray(process.owner)) {
      errors.push(`processes[${index}].owner は必須です`);
      continue;
    }
    const { kind } = process.owner;
    if (!['artifact', 'external', 'manual'].includes(kind)) errors.push(`unknown owner.kind: ${process.id || index} -> ${String(kind)}`);
    if (kind === 'artifact' && (typeof process.owner.path !== 'string' || !process.owner.path || path.isAbsolute(process.owner.path) || process.owner.path.includes('\\'))) {
      errors.push(`artifact.path は / 区切りのリポジトリ相対パスでなければなりません: ${process.id || index}`);
    }
    if (kind === 'external' && (typeof process.owner.ref !== 'string' || !process.owner.ref)) errors.push(`external.ref は必須です: ${process.id || index}`);
  }
  return errors;
}

function compareId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildReport(catalog, repo) {
  const domainOrder = new Map(catalog.domains.map((domain, index) => [domain.key, index]));
  const processes = [...catalog.processes].sort((a, b) => domainOrder.get(a.domain) - domainOrder.get(b.domain) || compareId(a, b));
  const statusOf = (process) => {
    if (process.owner.kind === 'manual') return 'gap';
    if (process.owner.kind === 'external') return 'unverified';
    return fs.existsSync(path.join(repo, process.owner.path)) ? 'covered' : 'gap';
  };
  const domains = catalog.domains.map((domain) => {
    const items = processes.filter((process) => process.domain === domain.key);
    const covered = items.filter((process) => statusOf(process) === 'covered').length;
    const unverified = items.filter((process) => statusOf(process) === 'unverified').length;
    const gap = items.length - covered - unverified;
    return { ...domain, total: items.length, covered, unverified, gap, rate: items.length ? Math.round(covered / items.length * 100) : null };
  });
  const totals = domains.reduce((sum, domain) => ({
    total: sum.total + domain.total,
    covered: sum.covered + domain.covered,
    unverified: sum.unverified + domain.unverified,
    gap: sum.gap + domain.gap,
  }), { total: 0, covered: 0, unverified: 0, gap: 0 });
  totals.rate = totals.total ? Math.round(totals.covered / totals.total * 100) : null;
  return { domains, totals, processes, statusOf };
}

function rate(value) {
  return value === null ? '-' : `${value}%`;
}

function renderMarkdown(catalog, report) {
  const lines = [
    '# エージェント連携 業務自動化カバレッジ',
    '',
    '> このファイルは生成物。手で編集しない。再生成: `node tools/agent-integration-plan.mjs --write`',
    `> 台帳: \`tools/agent-integration-catalog.json\`（更新: ${catalog.updatedAt}）`,
    '> 自動化済の判定は推測ではなく**リポジトリ内の実ファイルの存在**で行う。`external` は本リポジトリから検証できないため自動化率の分子に数えない。',
    '',
    '## サマリ',
    '',
    '| ドメイン | 工程数 | 自動化済 | 未検証 | 人手 | 自動化率 |',
    '|---|---:|---:|---:|---:|---:|',
    ...report.domains.map((domain) => `| ${domain.label} | ${domain.total} | ${domain.covered} | ${domain.unverified} | ${domain.gap} | ${rate(domain.rate)} |`),
    `| **合計** | **${report.totals.total}** | **${report.totals.covered}** | **${report.totals.unverified}** | **${report.totals.gap}** | **${rate(report.totals.rate)}** |`,
    '',
    '## ドメイン別の内訳',
    '',
  ];
  for (const domain of report.domains) {
    lines.push(`### ${domain.label}`, '', '| 工程 | 状態 | 根拠 | 人手で残る部分 |', '|---|---|---|---|');
    for (const process of report.processes.filter((item) => item.domain === domain.key)) {
      const status = report.statusOf(process);
      const label = status === 'covered' ? '自動化済' : status === 'unverified' ? '未検証' : '人手';
      const evidence = process.owner.kind === 'artifact' ? `\`${process.owner.path}\`` : process.owner.kind === 'external' ? `\`${process.owner.ref}\`` : '（自動化資産なし）';
      lines.push(`| ${process.name} | ${label} | ${evidence} | ${process.manualRemainder} |`);
    }
    lines.push('');
  }
  const manual = report.processes.filter((process) => process.owner.kind === 'manual');
  lines.push('## 次に作るべきエージェント（人手が残る工程）', '');
  if (manual.length) manual.forEach((process, index) => lines.push(`${index + 1}. **[${process.domain}] ${process.name}** — ${process.manualRemainder}`));
  else lines.push('- なし');
  lines.push('', '## 未検証（本リポジトリから確認できない工程）', '');
  const external = report.processes.filter((process) => process.owner.kind === 'external');
  if (external.length) external.forEach((process) => lines.push(`- **[${process.domain}] ${process.name}** — \`${process.owner.ref}\`（本リポジトリ外）`));
  else lines.push('- なし');
  return `${lines.join('\n')}\n`;
}

export function runPlan(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const catalogPath = options.catalogPath || path.join(repo, 'tools', 'agent-integration-catalog.json');
  const docPath = options.docPath || path.join(repo, 'docs', 'agent-integration-plan.md');
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const errors = validateCatalog(catalog);
    if (errors.length) throw new Error(errors.join('\n'));
    const report = buildReport(catalog, repo);
    const markdown = renderMarkdown(catalog, report);
    if (options.check) {
      const drift = catalog.processes
        .filter((process) => process.owner.kind === 'artifact' && !fs.existsSync(path.join(repo, process.owner.path)))
        .map((process) => `drift: ${process.id} -> ${process.owner.path} が存在しません`);
      // 改行は比較しない: .gitattributes の `* text=auto` により、core.autocrlf=true の PC では
      // チェックアウト時に CRLF へ変換される。CRLF 差だけで「古い」と誤判定すると、実データが
      // 一致しているのに CI / 各PCで check が落ちる。
      const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null;
      if (current !== markdown) drift.push('drift: docs/agent-integration-plan.md が古い。node tools/agent-integration-plan.mjs --write で再生成');
      if (drift.length) throw new Error(drift.join('\n'));
      return 0;
    }
    if (options.json) {
      const result = { domains: report.domains, totals: report.totals, gaps: report.processes.filter((process) => process.owner.kind === 'manual').map((process) => process.id) };
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (options.write) {
      fs.mkdirSync(path.dirname(docPath), { recursive: true });
      fs.writeFileSync(docPath, markdown.replace(/\r\n/gu, '\n'), 'utf8');
    } else stdout.write(markdown);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = new Set(['--write', '--check', '--json']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length || args.filter((arg) => known.has(arg)).length > 1) {
    process.stderr.write(`不正な引数です: ${unknown.join(', ') || 'モードは1つだけ指定してください'}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = runPlan({ write: args.includes('--write'), check: args.includes('--check'), json: args.includes('--json') });
  }
}
